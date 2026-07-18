import { Address, Hex } from "viem";
import { Hash } from "./commitment.js";

/**
 * Represents a deposit event from a privacy pool
 */
export interface DepositEvent {
  depositor: string;
  commitment: Hash;
  label: Hash;
  value: bigint;
  precommitment: Hash;
  blockNumber: bigint;
  transactionHash: Hex;
}

/**
 * Represents a withdrawal event from a privacy pool
 */
export interface WithdrawalEvent {
  withdrawn: bigint;
  spentNullifier: Hash;
  /** The L1 change note — the leaf actually inserted into the L1 tree. */
  newCommitment: Hash;
  /** `C_dest`, the bridged destination note. Delivered to L2, never inserted on L1. */
  newCommitmentL2: Hash;
  blockNumber: bigint;
  transactionHash: Hex;
}

/**
 * Represents a ragequit event from a privacy pool
 */
export interface RagequitEvent {
  ragequitter: string;
  commitment: Hash;
  label: Hash;
  value: bigint;
  blockNumber: bigint;
  transactionHash: Hex;
}

/**
 * The L1 `L2Note(_newCommitmentHashL2, _ephemeralKey, _viewTag)` event — the
 * note-delivery half of a Mode-3 relay. Carries the ephemeral key + view tag a
 * recipient scans for. Value is NOT here; it arrives via the bridge and is
 * observed on L2 as {@link L2NoteReceivedEvent} (or from the L1 `Withdrawn`
 * event's `_value`).
 */
export interface L2NoteEvent {
  /** `C_dest` — the bridged destination commitment. */
  commitment: Hash;
  /** `E = e·G` — the ephemeral public key, `[x, y]`. */
  ephemeralKey: readonly [bigint, bigint];
  /** Low byte of `Poseidon(ss)`, as a hex `bytes1`. */
  viewTag: Hex;
  blockNumber: bigint;
  transactionHash: Hex;
}

/**
 * The L2 `NoteReceived(_commitment, _value)` event — bridged tokens + note
 * message have landed; the note is *pending* until activated (CLAUDE.md §6).
 */
export interface L2NoteReceivedEvent {
  commitment: Hash;
  value: bigint;
  blockNumber: bigint;
  transactionHash: Hex;
}

/**
 * The L2 `NoteActivated(_commitment, _value)` event — the note became
 * *spendable* (matching bridged tokens confirmed) and was inserted into the L2
 * state tree. Insertion order defines the L2 Merkle leaves.
 */
export interface L2NoteActivatedEvent {
  commitment: Hash;
  value: bigint;
  blockNumber: bigint;
  transactionHash: Hex;
}

/**
 * Configuration for a chain's data provider
 */
export interface ChainConfig {
  chainId: number;
  privacyPoolAddress: Address;
  startBlock: bigint;
  rpcUrl: string;
}

/**
 * Event filter options
 */
export interface EventFilterOptions {
  fromBlock?: bigint;
  toBlock?: bigint;
  depositor?: string;
  limit?: number;
  skip?: number;
}

/**
 * Collection of pool events
 */
export interface PoolEvents {
  deposits: DepositEvent[];
  withdrawals: WithdrawalEvent[];
}

export interface PoolEventsSuccess {
  depositEvents: Map<Hash, DepositEvent>;
  withdrawalEvents: Map<Hash, WithdrawalEvent>;
  ragequitEvents: Map<Hash, RagequitEvent>;
}

export interface PoolEventsError {
  reason: string;
  scope: Hash;
}

export type PoolEventsResult = Map<Hash, PoolEventsSuccess | PoolEventsError>;

export type ProcessedDepositEventsResult = Map<Hash, DepositEvent>;