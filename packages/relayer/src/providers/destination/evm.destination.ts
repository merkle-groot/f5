import { Abi, Address, createPublicClient, http, PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  Circuits,
  ContractInteractionsService,
  PrivacyPoolSDK,
  WithdrawalProof,
} from "@0xbow/privacy-pools-core-sdk";
import { EvmDestinationConfig } from "../../config/types.js";
import { DestinationError } from "../../exceptions/base.exception.js";
import { createChainObject } from "../../utils.js";
import { KeyedSerialExecutor } from "../../utils/keyedSerialExecutor.js";
import { retryRpc } from "../../utils/rpcRetry.js";
import { rpcThrottle } from "../../utils/rpcThrottle.js";
import {
  ActivationState,
  DestinationProvider,
  DestinationTransaction,
  DestinationWithdrawal,
  EvmDestinationWithdrawal,
} from "./types.js";

/**
 * Only the views needed to verify one nominated activation.
 *
 * There are no event definitions here any more: discovering activatable notes is the
 * app server's job, and the relayer only verifies the specific note it was asked to
 * activate.
 */
const POOL_ABI = [
  {
    type: "function",
    name: "pendingValue",
    stateMutability: "view",
    inputs: [{ name: "commitment", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "activatedSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "tokensReceivedFromBridge",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const satisfies Abi;

const MULTICALL3_ADDRESS = (process.env.MULTICALL3_ADDRESS ??
  "0xcA11bde05977b3631167028862bE2a173976CA11") as Address;

/**
 * Writes to one EVM destination pool.
 *
 * Note this targets the **pool** directly, not an entrypoint — unlike `SdkProvider`,
 * which builds its contract instances against `entrypoint_address` for the L1 relay.
 */
export class EvmDestinationProvider implements DestinationProvider {
  readonly family = "evm" as const;
  readonly key: string;
  readonly chainId: string;
  readonly chainName: string;
  readonly poolAddress: string;

  private readonly config: EvmDestinationConfig;
  private readonly client: PublicClient;
  private readonly contracts: ContractInteractionsService | null;
  private readonly account: ReturnType<typeof privateKeyToAccount> | null;
  private readonly queue: KeyedSerialExecutor;

  constructor(
    config: EvmDestinationConfig,
    signerKey: string | undefined,
    queue: KeyedSerialExecutor,
  ) {
    this.config = config;
    this.key = config.key;
    this.chainId = String(config.chain_id);
    this.chainName = config.chain_name;
    this.poolAddress = config.pool_address;
    this.queue = queue;

    const chain = createChainObject({
      chain_id: config.chain_id,
      chain_name: config.chain_name,
      rpc_url: config.rpc_url,
      native_currency: config.native_currency,
    });
    this.client = createPublicClient({ chain, transport: http(config.rpc_url) });

    // A destination without a key is still useful: it can be read and reported as
    // unconfigured, which is what lets the UI grey it out instead of failing mid-flow.
    if (signerKey) {
      this.account = privateKeyToAccount(signerKey as `0x${string}`);
      this.contracts = new PrivacyPoolSDK(new Circuits({ browser: false })).createContractInstance(
        config.rpc_url,
        chain,
        config.pool_address as Address,
        signerKey as `0x${string}`,
      );
    } else {
      this.account = null;
      this.contracts = null;
    }
  }

  signerAddress(): string | null {
    return this.account?.address ?? null;
  }

  private requireContracts(): ContractInteractionsService {
    if (!this.contracts) {
      throw DestinationError.notConfigured(
        `Destination "${this.key}" (${this.chainName}) has no signing key; set DESTINATION_${this.key.toUpperCase()}_PRIVATE_KEY.`,
      );
    }
    return this.contracts;
  }

  /** Serialize per signer so concurrent requests cannot reuse one nonce. */
  private queueKey(): string {
    return `evm:${this.chainId}:${this.signerAddress()?.toLowerCase() ?? "none"}`;
  }

  async activateNote(commitment: bigint): Promise<DestinationTransaction> {
    const contracts = this.requireContracts();
    return this.queue.run(this.queueKey(), async () => {
      const submitted = await contracts.activateNote(this.poolAddress as Address, commitment);
      await this.confirm(submitted.hash, "activation");
      return { hash: submitted.hash };
    });
  }

  async withdraw(
    withdrawal: DestinationWithdrawal,
    proof: WithdrawalProof,
  ): Promise<DestinationTransaction> {
    const contracts = this.requireContracts();
    const evmWithdrawal = withdrawal as EvmDestinationWithdrawal;

    // The pool pays the recipient but WE pay the gas, and it reverts unless the
    // caller is the named processooor. Checking here turns a burnt-gas revert into
    // a free 400.
    const signer = this.signerAddress();
    if (signer && evmWithdrawal.processooor.toLowerCase() !== signer.toLowerCase()) {
      throw DestinationError.processooorNotRelayer(
        `Expected processooor "${signer}", got "${evmWithdrawal.processooor}".`,
      );
    }

    return this.queue.run(this.queueKey(), async () => {
      const submitted = await contracts.withdrawL2(
        this.poolAddress as Address,
        evmWithdrawal,
        proof,
      );
      await this.confirm(submitted.hash, "withdrawal");
      return { hash: submitted.hash };
    });
  }

  /**
   * A mined transaction is not a successful one. Without this check a reverted
   * activation would be reported to the caller as a success with a hash.
   */
  private async confirm(hash: string, label: string): Promise<void> {
    const receipt = await this.client.waitForTransactionReceipt({ hash: hash as `0x${string}` });
    if (receipt.status !== "success") {
      throw new Error(`${label} transaction ${hash} reverted`);
    }
  }

  /**
   * Read the pool's view of ONE commitment.
   *
   * Batched through Multicall3 so the whole check is a single RPC round trip. All
   * three values must come from the same block, or the backing arithmetic could mix
   * a pre-activation supply with a post-activation pending value.
   */
  async activationState(commitment: bigint): Promise<ActivationState> {
    const [pendingValue, activatedSupply, tokensReceived] = await rpcThrottle.call(
      this.config.rpc_url,
      () =>
        retryRpc(() =>
          this.client.multicall({
            allowFailure: false,
            multicallAddress: MULTICALL3_ADDRESS,
            contracts: [
              {
                address: this.poolAddress as Address,
                abi: POOL_ABI,
                functionName: "pendingValue",
                args: [commitment],
              },
              {
                address: this.poolAddress as Address,
                abi: POOL_ABI,
                functionName: "activatedSupply",
              },
              {
                address: this.poolAddress as Address,
                abi: POOL_ABI,
                functionName: "tokensReceivedFromBridge",
              },
            ],
          }),
        ),
    );
    return { pendingValue, activatedSupply, tokensReceived };
  }
}
