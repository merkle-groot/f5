import { WithdrawalProof } from "@0xbow/privacy-pools-core-sdk";

/**
 * An EVM destination withdrawal: the `Withdrawal{processooor,data}` struct the L2
 * pool's `withdraw` takes, where `data` is ABI-encoded `L2RelayData`.
 */
export interface EvmDestinationWithdrawal {
  processooor: `0x${string}`;
  data: `0x${string}`;
}

/**
 * A Starknet destination withdrawal. Flat felts rather than a struct with encoded
 * bytes: Cairo has no `abi.encode`, so the pool takes the fields directly and the
 * recipient is a felt252, not an address.
 */
export interface StarknetDestinationWithdrawal {
  processooor: string;
  recipient: string;
  feeRecipient: string;
  relayFeeBPS: string;
}

export type DestinationWithdrawal =
  | EvmDestinationWithdrawal
  | StarknetDestinationWithdrawal;

export interface DestinationTransaction {
  hash: string;
}

/**
 * Everything needed to decide whether ONE commitment may be activated.
 *
 * Read from per-commitment contract views rather than by replaying event logs. That
 * is the whole reason the relayer no longer indexes: scanning was only ever a way to
 * *discover* activatable notes, and discovery is the app server's job now. Verifying
 * a specific note the app server nominated takes a handful of `eth_call`s.
 */
export interface ActivationState {
  /** Non-zero iff the pool has received this note and not yet activated it. */
  pendingValue: bigint;
  activatedSupply: bigint;
  tokensReceived: bigint;
}

/**
 * One destination (L2) shielded pool the relayer can write to.
 *
 * Implementations own everything family-specific: felt encoding, proof calldata
 * conversion, receipt semantics. Callers above this interface — the handlers and the
 * auto-activator — are family-agnostic.
 */
export interface DestinationProvider {
  readonly key: string;
  readonly family: "evm" | "starknet";
  readonly chainId: string;
  readonly chainName: string;
  readonly poolAddress: string;

  /** The address that signs writes, or null when no key is configured. */
  signerAddress(): string | null;

  /** Promote a bridged pending note to spendable. */
  activateNote(commitment: bigint): Promise<DestinationTransaction>;

  /** Spend an activated note out of the pool. */
  withdraw(
    withdrawal: DestinationWithdrawal,
    proof: WithdrawalProof,
  ): Promise<DestinationTransaction>;

  /** Read just enough pool state to verify one nominated activation. */
  activationState(commitment: bigint): Promise<ActivationState>;
}
