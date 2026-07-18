import {
  RelayWithdrawal,
  WithdrawalProof,
} from "@0xbow/privacy-pools-core-sdk";
import { FeeCommitment } from "./common.js";

/**
 * Represents the proof payload for a relayer request.
 */
export interface ProofRelayerPayload {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
}

/**
 * Public signals for a Mode-3 `withdrawL1` (relay) proof. Circom emits circuit
 * outputs first, so the two `newCommitmentHash*` outputs lead; indices match
 * `WITHDRAW_L1_SIGNALS` in the SDK. 10 signals total (the L1 change note AND the
 * bridged `C_dest`).
 */
export interface WithdrawPublicSignals {
  /** [0] L1 change-note commitment (0-value for a full withdrawal). */
  newCommitmentHashL1: bigint;
  /** [1] `C_dest` — the bridged L2 destination commitment. */
  newCommitmentHashL2: bigint;
  /** [2] Hash of the spent note's nullifier. */
  existingNullifierHash: bigint;
  /** [3] Gross value spent from the L1 note. */
  withdrawnValue: bigint;
  /** [4] Net value delivered to L2 after the relay fee. */
  bridgedValue: bigint;
  /** [5] State root the inclusion proof was built against. */
  stateRoot: bigint;
  /** [6] Depth of the state tree. */
  stateTreeDepth: bigint;
  /** [7] ASP association root. */
  ASPRoot: bigint;
  /** [8] Depth of the ASP tree. */
  ASPTreeDepth: bigint;
  /** [9] Context binding the proof to the relay request. */
  context: bigint;
}

/**
 * Represents the request body for a relayer operation.
 */
export interface RelayRequestBody {
  /** Withdrawal details */
  withdrawal: RelayWithdrawal;
  /** Public signals as string array */
  publicSignals: string[];
  /** Proof details */
  proof: ProofRelayerPayload;
  /** Fee commitment */
  feeCommitment?: FeeCommitment;
  /** Pool scope */
  scope: string;
  /** Chain ID to process the request on */
  chainId: string | number;
}

/**
 * Complete withdrawal payload including proof and public signals.
 */
export interface WithdrawalPayload {
  readonly proof: WithdrawalProof;
  readonly withdrawal: RelayWithdrawal;
  readonly scope: bigint;
  readonly feeCommitment?: FeeCommitment;
}

/**
 * Represents the response from a relayer operation.
 */
export interface RelayerResponse {
  /** Indicates if the request was successful */
  success: boolean;
  /** Timestamp of the response */
  timestamp: number;
  /** Unique request identifier (UUID) */
  requestId: string;
  /** Optional transaction hash */
  txHash?: string;
  /** Optional transaction swap hash */
  txSwap?: string;
  /** Optional error message */
  error?: string;
}

/**
 * Enum representing the possible statuses of a relayer request.
 */
export const enum RequestStatus {
  /** Request has been received */
  RECEIVED = "RECEIVED",
  /** Request has been broadcasted */
  BROADCASTED = "BROADCASTED",
  /** Request has failed */
  FAILED = "FAILED",
}
