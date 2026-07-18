import { Address } from "viem";
import {
  RelayWithdrawal,
  WithdrawalProof,
} from "../types/withdrawal.js";
import { CommitmentProof, Hash } from "../types/commitment.js";

export interface SolidityGroth16Proof {
  pA: [bigint, bigint];
  pB: [[bigint, bigint], [bigint, bigint]];
  pC: [bigint, bigint];
  pubSignals: bigint[];
}

export interface AssetConfig {
  pool: Address,
  minimumDepositAmount: bigint,
  vettingFeeBPS: bigint,
  maxRelayFeeBPS: bigint
}

export interface TransactionResponse {
  hash: string;
  wait: () => Promise<void>;
}

export interface ContractInteractions {
  depositERC20(
    asset: Address,
    amount: bigint,
    precommitment: bigint,
  ): Promise<TransactionResponse>;

  depositETH(
    amount: bigint,
    precommitment: bigint,
  ): Promise<TransactionResponse>;

  withdraw(
    withdrawal: RelayWithdrawal,
    withdrawalProof: WithdrawalProof,
    scope: Hash,
  ): Promise<TransactionResponse>;

  relay(
    withdrawal: RelayWithdrawal,
    withdrawalProof: WithdrawalProof,
    scope: Hash,
  ): Promise<TransactionResponse>;

  /**
   * The `msg.value` a `relay()` to `destinationChainId` must attach to cover the
   * canonical bridge's L1->L2 message/gas fee (0 for OP-Stack, non-zero for
   * Arbitrum/Starknet). The relayer uses this to price the fronted fee into its quote.
   */
  bridgeMsgValue(
    assetAddress: Address,
    destinationChainId: bigint,
  ): Promise<bigint>;

  ragequit(
    commitmentProof: CommitmentProof,
    privacyPoolAddress: Address,
  ): Promise<TransactionResponse>;

  getScope(privacyPoolAddress: Address): Promise<bigint>;
  getStateRoot(privacyPoolAddress: Address): Promise<bigint>;
  getStateSize(privacyPoolAddress: Address): Promise<bigint>;
  getAssetConfig(assetAddress: Address): Promise<AssetConfig>;
  getScopeData(
    scope: bigint,
  ): Promise<{ poolAddress: Address | null; assetAddress: Address | null }>;

  approveERC20(
    spenderAddress: Address,
    tokenAddress: Address,
    amount: bigint,
  ): Promise<TransactionResponse>;
}
