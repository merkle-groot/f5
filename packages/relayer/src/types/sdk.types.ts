import {
  Address,
  RelayWithdrawal,
  WithdrawalProof,
} from "@0xbow/privacy-pools-core-sdk";
import { WithdrawalPayload } from "../interfaces/relayer/request.js";

export interface SdkProviderInterface {
  verifyWithdrawal(withdrawalPayload: WithdrawalProof): Promise<boolean>;
  broadcastWithdrawal(
    withdrawalPayload: WithdrawalPayload,
    chainId: number,
  ): Promise<{ hash: string }>;
  calculateContext(withdrawal: RelayWithdrawal, scope: bigint): string;
  scopeData(
    scope: bigint,
    chainId: number,
  ): Promise<{ poolAddress: Address; assetAddress: Address }>;
  bridgeMsgValue(
    processingChainId: number,
    assetAddress: Address,
    destinationChainId: bigint,
  ): Promise<bigint>;
}
