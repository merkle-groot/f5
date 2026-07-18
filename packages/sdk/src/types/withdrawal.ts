import { Address, Hex } from "viem";
import { Groth16Proof, PublicSignals } from "snarkjs";
import { LeanIMTMerkleProof } from "@zk-kit/lean-imt";
import { Hash, Secret } from "./commitment.js";
import { Point } from "./stealth.js";

/**
 * The L2-leg withdrawal request (spend a stealth note in the destination
 * shielded pool). `processooor` is the on-chain caller bound into the context.
 */
export interface Withdrawal {
  readonly processooor: Address;
  readonly data: Hex;
}

/**
 * The L1-leg (relay) withdrawal request. Unlike the L2 leg there is no
 * `processooor`: the destination is a `chainId` and the payload rides in `data`
 * (a `RelayData` ABI-encoding). This is the shape hashed into the L1 context and
 * passed to `PrivacyPool.relay()`.
 */
export interface RelayWithdrawal {
  readonly chainId: bigint;
  readonly data: Hex;
}

/**
 * Decoded payload carried in `RelayWithdrawal.data` for the L1 relay leg.
 * Carries the ephemeral key + view tag the recipient needs to scan (CLAUDE.md
 * §4), plus relayer economics bound as anti-theft context.
 */
export interface RelayData {
  readonly recipient: Address;
  readonly feeRecipient: Address;
  readonly ephemeralKey: Point;
  /** Low byte of `Poseidon(ss)`, ABI-encoded as `bytes1`. */
  readonly viewTag: Hex;
  readonly relayFeeBPS: bigint;
}

/**
 * Decoded payload carried in `Withdrawal.data` for the L2 spend leg. No
 * ephemeral key / view tag — those only matter at note delivery, not spend.
 */
export interface L2RelayData {
  readonly recipient: Address;
  readonly feeRecipient: Address;
  readonly relayFeeBPS: bigint;
}

export interface WithdrawalProof {
  readonly proof: Groth16Proof;
  readonly publicSignals: PublicSignals;
}

/**
 * @deprecated Phase 3 splits this into {@link WithdrawL1ProofInput} /
 * {@link WithdrawL2ProofInput}. Retained until the service split lands.
 */
export interface WithdrawalProofInput {
  readonly context: bigint;
  readonly withdrawalAmount: bigint;
  readonly stateMerkleProof: LeanIMTMerkleProof<bigint>;
  readonly aspMerkleProof: LeanIMTMerkleProof<bigint>;
  readonly stateRoot: Hash;
  readonly stateTreeDepth: bigint;
  readonly aspRoot: Hash;
  readonly aspTreeDepth: bigint;
  readonly newSecret: Secret;
  readonly newNullifier: Secret;
}

/**
 * Input parameters required for `withdrawL1` proof generation (Mode-3 relay).
 * Field names match the circuit's expected input signals (see
 * `packages/circuits/scripts/e2e/relay.mjs`).
 */
export interface WithdrawL1ProofInput {
  readonly context: bigint;
  /** Bridged value; equals the spent note value for a full withdrawal. */
  readonly withdrawnValue: bigint;
  /** Net value delivered to the destination L2 after the relay fee. */
  readonly bridgedValue?: bigint;
  readonly stateMerkleProof: LeanIMTMerkleProof<bigint>;
  readonly aspMerkleProof: LeanIMTMerkleProof<bigint>;
  readonly stateRoot: Hash;
  readonly stateTreeDepth: bigint;
  readonly aspRoot: Hash;
  readonly aspTreeDepth: bigint;
  /** Recipient spend public key `B` — folded into `C_dest` via `P`. */
  readonly spendingPublicKey: Point;
  /** ECDH shared-secret x-coordinate `ss = e·V`. */
  readonly sharedSecretX: bigint;
  /** L1 change-note secrets (change value is 0 for a full withdrawal). */
  readonly newNullifier: Secret;
  readonly newSecret: Secret;
}

/**
 * Input parameters required for `withdrawL2` proof generation (Mode-3 spend).
 * Field names match the circuit's expected input signals (see
 * `packages/circuits/scripts/e2e/l2withdraw.mjs`).
 */
export interface WithdrawL2ProofInput {
  readonly context: bigint;
  readonly noteValue: bigint;
  readonly stateMerkleProof: LeanIMTMerkleProof<bigint>;
  readonly stateRoot: Hash;
  readonly stateTreeDepth: bigint;
  /** `sk = (b + Poseidon(ss)) mod L` — opens the Poseidon ownership constraint. */
  readonly stealthPrivateKey: Secret;
  readonly sharedSecretX: bigint;
}

/**
 * Public-signal indices for `withdrawL1`. MUST match `ProofLib.sol`.
 *
 * Circom derives this order from the TEMPLATE's signal DECLARATION order —
 * outputs first, then inputs — NOT from the order listed in `component main
 * {public [...]}`. The `main` list happens to name `bridgedValue` last, but the
 * template declares it second (right after `withdrawnValue`), so it lands at
 * index 4 and shifts `stateRoot`..`context` down by one.
 *
 * Verified against `packages/circuits/build/withdrawL1/withdrawL1.sym`, which is
 * the ground truth; `signalOrder.test.ts` re-derives it from that artifact on
 * every run so this constant cannot silently drift from the circuit again.
 */
export const WITHDRAW_L1_SIGNALS = {
  newCommitmentHashL1: 0,
  /** `C_dest` — the bridged L2 note. */
  newCommitmentHashL2: 1,
  existingNullifierHash: 2,
  withdrawnValue: 3,
  bridgedValue: 4,
  stateRoot: 5,
  stateTreeDepth: 6,
  aspRoot: 7,
  aspTreeDepth: 8,
  context: 9,
} as const;

/**
 * Public-signal indices for `withdrawL2`. MUST match `L2ProofLib.sol`
 * (`pubSignals[0]=existingNullifierHash`, `pubSignals[1]=noteValue`) — the
 * signal-order bug that bit the live run. See Phase 6 regression test.
 */
export const WITHDRAW_L2_SIGNALS = {
  existingNullifierHash: 0,
  noteValue: 1,
  stateRoot: 2,
  stateTreeDepth: 3,
  context: 4,
} as const;
