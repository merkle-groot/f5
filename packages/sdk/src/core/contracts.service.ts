import {
  Abi,
  Account,
  Address,
  Chain,
  Hex,
  PublicClient,
  WalletClient,
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
} from "viem";
import {
  RelayWithdrawal,
  Withdrawal,
  WithdrawalProof,
} from "../types/withdrawal.js";
import {
  AssetConfig,
  ContractInteractions,
  TransactionResponse,
} from "../interfaces/contracts.interface.js";
import { IEntrypointABI } from "../abi/IEntrypoint.js";
import { IPrivacyPoolABI } from "../abi/IPrivacyPool.js";
import { IL2PrivacyPoolABI } from "../abi/IL2PrivacyPool.js";
import { ERC20ABI } from "../abi/ERC20.js";
import { privateKeyToAccount } from "viem/accounts";
import { CommitmentProof, Hash } from "../types/commitment.js";
import { bigintToHex } from "../crypto.js";
import { ContractError } from "../errors/base.error.js";

/** Sentinel address used by the pools to represent the native asset. */
const NATIVE_ASSET: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

/**
 * Explicit gas for `relay()`. The OP canonical messenger's `sendMessage` is
 * under-estimated by `eth_estimateGas` (observed live), so the relay reverts if
 * left to auto-estimation. Mirrors the e2e's `gas: 3_000_000n`.
 */
const RELAY_GAS_LIMIT = 3_000_000n;

export class ContractInteractionsService implements ContractInteractions {
  private publicClient: PublicClient;
  private walletClient: WalletClient;
  private entrypointAddress: Address;
  private account: Account;

  /**
   * Initializes the contract interactions service.
   *
   * @param rpcUrl - The RPC endpoint URL for the blockchain network.
   * @param chain - The blockchain network configuration.
   * @param entrypointAddress - The address of the entrypoint contract.
   * @param accountPrivateKey - The private key used for signing transactions.
   */
  constructor(
    rpcUrl: string,
    chain: Chain,
    entrypointAddress: Address,
    accountPrivateKey: Hex,
  ) {
    if (!entrypointAddress) {
      throw new Error(
        "Invalid entrypoint addresses provided to ContractInteractionsService",
      );
    }

    this.account = privateKeyToAccount(accountPrivateKey);

    this.walletClient = createWalletClient({
      chain: chain,
      transport: http(rpcUrl),
      account: this.account,
    });

    this.publicClient = createPublicClient({
      chain: chain,
      transport: http(rpcUrl),
    });

    this.entrypointAddress = entrypointAddress;
  }

  /**
   * Deposits ERC20 tokens into the privacy pool.
   *
   * @param asset - The address of the ERC20 token.
   * @param amount - The amount of tokens to deposit.
   * @param precommitment - The precommitment value.
   * @returns Transaction response containing the transaction hash.
   */
  async depositERC20(
    asset: Address,
    amount: bigint,
    precommitment: bigint,
  ): Promise<TransactionResponse> {
    try {
      // Deposits go directly to the pool, which pulls the funds itself.
      const { pool } = await this.getAssetConfig(asset);
      const { request } = await this.publicClient.simulateContract({
        address: pool,
        abi: IPrivacyPoolABI as Abi,
        functionName: "deposit",
        args: [amount, precommitment],
        value: 0n,
        account: this.account,
      });
      return await this.executeTransaction(request);
    } catch (error) {
      console.error("Deposit ERC20 Error:", { error, asset, amount });
      throw new Error(
        `Failed to deposit ERC20: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Deposits ETH into the privacy pool.
   *
   * @param amount - The amount of ETH to deposit.
   * @param precommitment - The precommitment value.
   * @returns Transaction response containing the transaction hash.
   */
  async depositETH(
    amount: bigint,
    precommitment: bigint,
  ): Promise<TransactionResponse> {
    try {
      // Resolve the native asset pool and deposit directly into it.
      const { pool } = await this.getAssetConfig(NATIVE_ASSET);
      const { request } = await this.publicClient.simulateContract({
        address: pool,
        abi: IPrivacyPoolABI as Abi,
        functionName: "deposit",
        args: [precommitment],
        value: amount,
        account: this.account,
      });

      return await this.executeTransaction(request);
    } catch (error) {
      console.error("Deposit ETH Error:", { error, amount });
      throw new Error(
        `Failed to deposit ETH: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * @deprecated Use {@link relay}. The merged pool exposes a single L1
   * withdrawal entry point (`relay`); this is a thin alias kept for callers that
   * still say `withdraw`.
   *
   * @param withdrawal - The relay withdrawal (`{chainId, data}`).
   * @param withdrawalProof - The `withdrawL1` proof.
   * @returns Transaction response containing the transaction hash.
   */
  async withdraw(
    withdrawal: RelayWithdrawal,
    withdrawalProof: WithdrawalProof,
    scope: Hash,
  ): Promise<TransactionResponse> {
    // Thin alias: the merged pool exposes a single withdrawal entry point.
    // Delegate so this path inherits the bridge-fee `msg.value` and the explicit
    // relay gas limit rather than duplicating (and drifting from) `relay`.
    try {
      return await this.relay(withdrawal, withdrawalProof, scope);
    } catch (error) {
      throw new Error(
        `Failed to Withdraw: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Relays a Mode-3 withdrawal directly to the L1 pool: burns the spent note and
   * emits the bridge + note-delivery ops toward `withdrawal.chainId`.
   *
   * @param withdrawal - The relay withdrawal (`{chainId, data}`), where
   *   `chainId` is the destination and `data` is the encoded `RelayData`.
   * @param withdrawalProof - The `withdrawL1` proof (9 public signals).
   * @param scope - Pool scope, used to resolve the pool address.
   * @returns Transaction response containing hash and wait function.
   */
  async relay(
    withdrawal: RelayWithdrawal,
    withdrawalProof: WithdrawalProof,
    scope: Hash,
  ): Promise<TransactionResponse> {
    try {
      const formattedProof = this.formatProof(withdrawalProof);

      // Relay is now processed directly on the pool; resolve it from the scope.
      const scopeData = await this.getScopeData(scope);

      // The pool fronts the canonical bridge's L1->L2 message fee out of
      // `msg.value` (PrivacyPool._bridge). OP-Stack messages ride on L1-derived
      // gas and need nothing, but Starknet/StarkGate and Arbitrum charge a
      // prepaid ETH fee — omitting it reverts with `InsufficientBridgeFee`.
      // Compute exactly what the on-chain branch will demand for this destination.
      const value = await this.bridgeMsgValue(
        scopeData.assetAddress,
        withdrawal.chainId,
      );

      const { request } = await this.publicClient.simulateContract({
        address: scopeData.poolAddress,
        abi: IPrivacyPoolABI as Abi,
        functionName: "relay",
        account: this.account,
        args: [withdrawal, formattedProof],
        value,
        // OP messenger sendMessage under-estimates via eth_estimateGas.
        gas: RELAY_GAS_LIMIT,
      });

      return await this.executeTransaction(request);
    } catch (error) {
      console.error("Withdraw Error Details:", {
        error,
        accountAddress: this.account.address,
      });
      throw error;
    }
  }

  /**
   * Required `msg.value` for a `relay()` to `destinationChainId`.
   *
   * Mirrors `PrivacyPool._bridge` exactly so the simulated value always clears the
   * pool's `InsufficientBridgeFee` check, per {@link IEntrypoint.BridgeKind}:
   *  - OpStack   — the note rides on L1-derived gas; nothing is prepaid (0).
   *  - Arbitrum  — a retryable ticket prepays submission + L2 gas; ERC20 adds a
   *                second (token) ticket.
   *  - Starknet  — StarkGate charges a flat ETH fee for each of the two L1->L2
   *                messages (the note message and the token deposit).
   *
   * The relayer fronts this from its own balance and is reimbursed by the relay
   * fee bound into the note. An unsupported destination returns 0 and lets the
   * pool surface its own `UnsupportedChain`.
   *
   * Public so the relayer can price the fronted fee into its quote (a destination
   * that prepays an L1->L2 fee must be reimbursed through the relay fee, or the
   * relayer bridges to Arbitrum/Starknet at a loss).
   *
   * @param assetAddress - The pool's asset (native sentinel or ERC20).
   * @param destinationChainId - `withdrawal.chainId`, the L2 destination.
   * @returns The ETH amount to attach as `msg.value`.
   */
  async bridgeMsgValue(
    assetAddress: Address,
    destinationChainId: bigint,
  ): Promise<bigint> {
    const config = (await this.publicClient.readContract({
      address: this.entrypointAddress,
      abi: IEntrypointABI as Abi,
      functionName: "getBridgeConfig",
      args: [destinationChainId, assetAddress],
    })) as {
      kind: number;
      isSupported: boolean;
      messageGasLimit: bigint;
      messageMaxFeePerGas: bigint;
      messageFee: bigint;
      tokenGasLimit: bigint;
      tokenMaxFeePerGas: bigint;
      tokenFee: bigint;
    };

    // Let the pool revert with its own `UnsupportedChain` rather than guessing.
    if (!config.isSupported) return 0n;

    const isNative =
      assetAddress.toLowerCase() === NATIVE_ASSET.toLowerCase();

    // BridgeKind: 0 = OpStack, 1 = Arbitrum, 2 = Starknet.
    switch (config.kind) {
      case 0:
        return 0n;
      case 1: {
        const messageFee =
          config.messageFee +
          config.messageGasLimit * config.messageMaxFeePerGas;
        if (isNative) return messageFee;
        const tokenFee =
          config.tokenFee + config.tokenGasLimit * config.tokenMaxFeePerGas;
        return messageFee + tokenFee;
      }
      case 2:
        return config.messageFee + config.tokenFee;
      default:
        return 0n;
    }
  }

  /**
   * Activates a bridged Mode-3 note on the destination (L2) pool: promotes a
   * *pending* note to *spendable* once matching bridged tokens have landed
   * (CLAUDE.md §6). Must be constructed against the L2 chain/RPC.
   *
   * @param l2PoolAddress - The destination L2 shielded pool.
   * @param commitmentHash - `C_dest` of the delivered note.
   */
  async activateNote(
    l2PoolAddress: Address,
    commitmentHash: bigint,
  ): Promise<TransactionResponse> {
    try {
      const { request } = await this.publicClient.simulateContract({
        address: l2PoolAddress,
        abi: IL2PrivacyPoolABI as Abi,
        functionName: "activateNote",
        account: this.account,
        args: [commitmentHash],
      });
      return await this.executeTransaction(request);
    } catch (error) {
      throw new Error(
        `Failed to activate note: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Spends an activated note on the destination (L2) pool with a `withdrawL2`
   * proof (5 public signals; `pubSignals[0]=nullifier, [1]=noteValue`). Must be
   * constructed against the L2 chain/RPC.
   *
   * @param l2PoolAddress - The destination L2 shielded pool.
   * @param withdrawal - The L2 `Withdrawal{processooor,data}`.
   * @param withdrawalProof - The `withdrawL2` Groth16 proof.
   */
  async withdrawL2(
    l2PoolAddress: Address,
    withdrawal: Withdrawal,
    withdrawalProof: WithdrawalProof,
  ): Promise<TransactionResponse> {
    try {
      const formattedProof = this.formatProof(withdrawalProof);
      const { request } = await this.publicClient.simulateContract({
        address: l2PoolAddress,
        abi: IL2PrivacyPoolABI as Abi,
        functionName: "withdraw",
        account: this.account,
        args: [withdrawal, formattedProof],
      });
      return await this.executeTransaction(request);
    } catch (error) {
      throw new Error(
        `Failed to withdraw on L2: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /** Reads the current L2 state-tree root. */
  async getL2Root(l2PoolAddress: Address): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: l2PoolAddress,
      abi: IL2PrivacyPoolABI as Abi,
      functionName: "currentRoot",
    })) as bigint;
  }

  /** Whether the bridged note `C_dest` has been received on L2 (pending or activated). */
  async isNoteReceived(
    l2PoolAddress: Address,
    commitmentHash: bigint,
  ): Promise<boolean> {
    return (await this.publicClient.readContract({
      address: l2PoolAddress,
      abi: IL2PrivacyPoolABI as Abi,
      functionName: "receivedCommitments",
      args: [commitmentHash],
    })) as boolean;
  }

  /** The still-pending (not-yet-activated) value for `C_dest`, or 0 once activated. */
  async getPendingValue(
    l2PoolAddress: Address,
    commitmentHash: bigint,
  ): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: l2PoolAddress,
      abi: IL2PrivacyPoolABI as Abi,
      functionName: "pendingValue",
      args: [commitmentHash],
    })) as bigint;
  }

  /** Whether an L2 nullifier has been spent. */
  async isL2NullifierSpent(
    l2PoolAddress: Address,
    nullifierHash: bigint,
  ): Promise<boolean> {
    return (await this.publicClient.readContract({
      address: l2PoolAddress,
      abi: IL2PrivacyPoolABI as Abi,
      functionName: "nullifierHashes",
      args: [nullifierHash],
    })) as boolean;
  }

  /**
   * Executes a ragequit operation, allowing a user to exit the pool
   * by nullifying their commitment and proving their withdrawal.
   *
   * @param commitmentProof - The cryptographic proof of the commitment.
   * @param privacyPoolAddress - The address of the privacy pool contract.
   * @returns Transaction response containing hash and wait function.
   */
  async ragequit(
    commitmentProof: CommitmentProof,
    privacyPoolAddress: Address,
  ): Promise<TransactionResponse> {
    try {
      const formattedProof = this.formatProof(commitmentProof);

      const { request } = await this.publicClient.simulateContract({
        address: privacyPoolAddress,
        abi: IPrivacyPoolABI as Abi,
        functionName: "ragequit",
        args: [formattedProof],
        account: this.account,
      });

      return await this.executeTransaction(request);
    } catch (error) {
      console.error("Ragequit Error:", { error });
      throw new Error(
        `Failed to Ragequit: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Retrieves the scope identifier of a given privacy pool.
   *
   * @param privacyPoolAddress - The address of the privacy pool contract.
   * @returns The scope identifier as a bigint.
   */
  async getScope(privacyPoolAddress: Address): Promise<bigint> {
    const scope = await this.publicClient.readContract({
      address: privacyPoolAddress,
      abi: IPrivacyPoolABI as Abi,
      functionName: "SCOPE",
      account: this.account,
    });

    return BigInt(scope as string);
  }

  /**
   * Retrieves the latest state root of the privacy pool from the entrypoint contract.
   *
   * @param privacyPoolAddress - The address of the privacy pool contract.
   * @returns The latest state root as a bigint.
   */
  async getStateRoot(privacyPoolAddress: Address): Promise<bigint> {
    const stateRoot = await this.publicClient.readContract({
      address: privacyPoolAddress,
      abi: IEntrypointABI as Abi,
      account: this.account,
      functionName: "latestRoot",
    });

    return BigInt(stateRoot as string);
  }

  /**
   * Retrieves the current state size of the privacy pool.
   *
   * @param privacyPoolAddress - The address of the privacy pool contract.
   * @returns The size of the state tree as a bigint.
   */
  async getStateSize(privacyPoolAddress: Address): Promise<bigint> {
    const stateSize = await this.publicClient.readContract({
      address: privacyPoolAddress,
      abi: IPrivacyPoolABI as Abi,
      account: this.account,
      // this should be added in the next update of PrivacyPoolSimple.sol
      functionName: "currentTreeSize",
    });

    return BigInt(stateSize as string);
  }


  /**
   * Retrieves data from the corresponding asset
   *
   * @param assetAddress - The asset contract address.
   * @returns AssetConfig - An object containing the privacy pool address, minimum deposit amount, vetting fee and maximum relaying fee.
   * @throws ContractError if the asset does not exist in the pool.
   */
  async getAssetConfig(assetAddress: Address): Promise<AssetConfig> {
    const assetConfig = await this.publicClient.readContract({
      address: this.entrypointAddress,
      abi: IEntrypointABI as Abi,
      account: this.account,
      args: [assetAddress],
      functionName: "assetConfig",
    });
    const [pool, minimumDepositAmount, vettingFeeBPS, maxRelayFeeBPS] = assetConfig as [string, bigint, bigint, bigint];

    // if no pool throw error
    if (
      !pool ||
      pool === "0x0000000000000000000000000000000000000000"
    ) {
      throw ContractError.assetNotFound(assetAddress);
    }

    return {
      pool: getAddress(pool),
      minimumDepositAmount,
      vettingFeeBPS,
      maxRelayFeeBPS
    }
  }

  /**
   * Retrieves data about a specific scope, including the associated privacy pool
   * and the asset used in that pool.
   *
   * @param scope - The scope identifier to look up.
   * @returns An object containing the privacy pool address and asset address.
   * @throws ContractError if the scope does not exist.
   */
  async getScopeData(
    scope: bigint,
  ): Promise<{ poolAddress: Address; assetAddress: Address }> {
    try {
      // get pool address fro entrypoint
      const poolAddress = await this.publicClient.readContract({
        address: this.entrypointAddress,
        abi: IEntrypointABI as Abi,
        account: this.account,
        args: [scope],
        functionName: "scopeToPool",
      });

      // if no pool throw error
      if (
        !poolAddress ||
        poolAddress === "0x0000000000000000000000000000000000000000"
      ) {
        throw ContractError.scopeNotFound(scope);
      }

      // get asset adress from pool
      const assetAddress = await this.publicClient.readContract({
        address: getAddress(poolAddress as string),
        abi: IPrivacyPoolABI as Abi,
        account: this.account,
        functionName: "ASSET",
      });

      return {
        poolAddress: getAddress(poolAddress as string),
        assetAddress: getAddress(assetAddress as string),
      };
    } catch (error) {
      if (error instanceof ContractError) throw error;
      console.error(`Error resolving scope ${scope.toString()}:`, error);
      throw new Error(
        `Failed to resolve scope ${scope.toString()}: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  /**
   * Approves the entrypoint contract to spend a specified amount of ERC20 tokens.
   *
   * @param spenderAddress - The address of the entity that will be approved to spend tokens.
   * @param tokenAddress - The address of the ERC20 token contract.
   * @param amount - The amount of tokens to approve.
   * @returns Transaction response containing hash and wait function.
   */
  async approveERC20(
    spenderAddress: Address,
    tokenAddress: Address,
    amount: bigint,
  ): Promise<TransactionResponse> {
    try {
      const { request } = await this.publicClient.simulateContract({
        address: tokenAddress,
        abi: ERC20ABI as Abi,
        functionName: "approve",
        args: [spenderAddress, amount],
        account: this.account,
      });

      return await this.executeTransaction(request);
    } catch (error) {
      console.error("ERC20 Approval Error:", { error, tokenAddress, amount });
      throw new Error(
        `Failed to approve ERC20: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  private formatProof(proof: CommitmentProof | WithdrawalProof) {
    return {
      pA: [
        bigintToHex(proof.proof.pi_a?.[0]),
        bigintToHex(proof.proof.pi_a?.[1]),
      ],
      pB: [
        [
          bigintToHex(proof.proof.pi_b?.[0]?.[1]),
          bigintToHex(proof.proof.pi_b?.[0]?.[0]),
        ],
        [
          bigintToHex(proof.proof.pi_b?.[1]?.[1]),
          bigintToHex(proof.proof.pi_b?.[1]?.[0]),
        ],
      ],
      pC: [
        bigintToHex(proof.proof.pi_c?.[0]),
        bigintToHex(proof.proof.pi_c?.[1]),
      ],
      pubSignals: proof.publicSignals.map(bigintToHex),
    };
  }

  private async executeTransaction(request: any): Promise<TransactionResponse> {
    try {
      const hash = await this.walletClient.writeContract(request);
      return {
        hash,
        wait: async () => {
          await this.publicClient.waitForTransactionReceipt({ hash });
        },
      };
    } catch (error) {
      console.error("Transaction Execution Error:", { error, request });
      throw new Error(
        `Transaction failed: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }
}
