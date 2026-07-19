import { Account, hash as snHash, RpcProvider } from "starknet";
import { WithdrawalProof } from "@0xbow/privacy-pools-core-sdk";
import { StarknetDestinationConfig } from "../../config/types.js";
import { DestinationError } from "../../exceptions/base.exception.js";
import { KeyedSerialExecutor } from "../../utils/keyedSerialExecutor.js";
import { retryRpc } from "../../utils/rpcRetry.js";
import { rpcThrottle } from "../../utils/rpcThrottle.js";
import { toGaragaCalldata } from "./garaga.js";
import {
  ActivationState,
  DestinationProvider,
  DestinationTransaction,
  DestinationWithdrawal,
  StarknetDestinationWithdrawal,
} from "./types.js";

/** A Cairo `u256` is two felts: [low, high]. */
function toU256(value: bigint): string[] {
  const mask = (1n << 128n) - 1n;
  return [value & mask, value >> 128n].map((part) => part.toString());
}

function fromU256(low: string | bigint, high: string | bigint): bigint {
  return BigInt(low) + (BigInt(high) << 128n);
}

/**
 * Encode the pool withdrawal arguments.
 *
 * Garaga's `getGroth16CallData` already returns the proof span in Cairo ABI form:
 * `[proofLength, ...fullProofWithHints]`. Do not prepend another length here.
 */
export function buildStarknetWithdrawalCalldata(
  withdrawal: StarknetDestinationWithdrawal,
  proofCalldata: readonly string[],
): string[] {
  return [
    withdrawal.processooor,
    withdrawal.recipient,
    withdrawal.feeRecipient,
    ...toU256(BigInt(withdrawal.relayFeeBPS ?? 0)),
    ...proofCalldata,
  ];
}

/**
 * Writes to the Starknet destination pool.
 *
 * Two things differ structurally from the EVM provider and are the reason this is a
 * separate implementation rather than a config flag: values are felt pairs rather
 * than 256-bit words, and the Groth16 proof must be converted to Garaga calldata
 * because the Cairo verifier cannot consume a snarkjs proof.
 *
 * Starknet.js 10.x speaks JSON-RPC 0.10.x, so the runtime and Cairo deployment tooling
 * can share a compatible endpoint.
 */
export class StarknetDestinationProvider implements DestinationProvider {
  readonly family = "starknet" as const;
  readonly key: string;
  readonly chainId: string;
  readonly chainName: string;
  readonly poolAddress: string;

  private readonly config: StarknetDestinationConfig;
  private readonly provider: RpcProvider;
  private readonly account: Account | null;
  private readonly queue: KeyedSerialExecutor;

  constructor(
    config: StarknetDestinationConfig,
    signerKey: string | undefined,
    queue: KeyedSerialExecutor,
  ) {
    this.config = config;
    this.key = config.key;
    this.chainId = config.chain_id;
    this.chainName = config.chain_name;
    this.poolAddress = config.pool_address;
    this.queue = queue;
    this.provider = new RpcProvider({ nodeUrl: config.rpc_url });
    this.account = signerKey
      ? new Account({
          provider: this.provider,
          address: config.relayer_address,
          signer: signerKey,
        })
      : null;
  }

  signerAddress(): string | null {
    return this.account ? this.config.relayer_address : null;
  }

  private requireAccount(): Account {
    if (!this.account) {
      throw DestinationError.notConfigured(
        `Destination "${this.key}" (${this.chainName}) has no signing key; set DESTINATION_${this.key.toUpperCase()}_PRIVATE_KEY.`,
      );
    }
    return this.account;
  }

  private queueKey(): string {
    return `starknet:${this.chainId}:${this.config.relayer_address.toLowerCase()}`;
  }

  async activateNote(commitment: bigint): Promise<DestinationTransaction> {
    const account = this.requireAccount();
    return this.queue.run(this.queueKey(), async () => {
      const submitted = await account.execute({
        contractAddress: this.poolAddress,
        entrypoint: "activate_note",
        calldata: toU256(commitment),
      });
      await this.provider.waitForTransaction(submitted.transaction_hash);
      return { hash: submitted.transaction_hash };
    });
  }

  async withdraw(
    withdrawal: DestinationWithdrawal,
    proof: WithdrawalProof,
  ): Promise<DestinationTransaction> {
    const account = this.requireAccount();
    const snWithdrawal = withdrawal as StarknetDestinationWithdrawal;

    // Same reasoning as the EVM provider: the pool rejects a caller that is not the
    // named processooor, and we would pay the fee to learn that.
    const signer = this.signerAddress();
    if (signer && BigInt(snWithdrawal.processooor) !== BigInt(signer)) {
      throw DestinationError.processooorNotRelayer(
        `Expected processooor "${signer}", got "${snWithdrawal.processooor}".`,
      );
    }

    const proofCalldata = await toGaragaCalldata(
      proof.proof,
      proof.publicSignals,
    );

    const calldata = buildStarknetWithdrawalCalldata(
      snWithdrawal,
      proofCalldata,
    );

    return this.queue.run(this.queueKey(), async () => {
      const submitted = await account.execute({
        contractAddress: this.poolAddress,
        entrypoint: "withdraw",
        calldata,
      });
      await this.provider.waitForTransaction(submitted.transaction_hash);
      return { hash: submitted.transaction_hash };
    });
  }

  /**
   * Read the pool's view of ONE commitment.
   *
   * `activated_supply` is a Cairo storage var with no entry in the pool's interface,
   * so it is read straight from its slot — `sn_keccak("activated_supply")`, the same
   * technique the app server already uses for `l1_pool`. A u256 occupies two
   * consecutive felts (low, high).
   *
   * Pinned to `latest`, not the default `pending`: the three reads must agree on a
   * block or the backing arithmetic mixes states, and some nodes (Alchemy v0.10)
   * reject `pending` outright with -32602 (FIXES.md).
   */
  async activationState(commitment: bigint): Promise<ActivationState> {
    const supplySlot = BigInt(
      `0x${snHash.starknetKeccak("activated_supply").toString(16)}`,
    );

    const [pendingParts, tokenParts, supplyLow, supplyHigh] = await Promise.all(
      [
        this.call("pending_value", toU256(commitment)),
        this.call("tokens_received_from_bridge", []),
        this.storageAt(supplySlot),
        this.storageAt(supplySlot + 1n),
      ],
    );

    return {
      pendingValue: fromU256(pendingParts[0]!, pendingParts[1]!),
      tokensReceived: fromU256(tokenParts[0]!, tokenParts[1]!),
      activatedSupply: fromU256(supplyLow, supplyHigh),
    };
  }

  private call(entrypoint: string, calldata: string[]): Promise<string[]> {
    return rpcThrottle.call(this.config.rpc_url, () =>
      retryRpc(() =>
        this.provider.callContract(
          {
            contractAddress: this.poolAddress,
            entrypoint,
            calldata,
          },
          "latest",
        ),
      ),
    );
  }

  private async storageAt(slot: bigint): Promise<string> {
    const result = await rpcThrottle.call(this.config.rpc_url, () =>
      retryRpc(() =>
        this.provider.getStorageAt(
          this.poolAddress,
          `0x${slot.toString(16)}`,
          "latest",
        ),
      ),
    );
    return result.value;
  }
}
