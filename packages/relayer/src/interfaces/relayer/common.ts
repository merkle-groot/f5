
/**
 * Represents the relayer commitment for a pre-built withdrawal.
 */
export interface FeeCommitment {
  withdrawalData: `0x${string}`,
  asset: `0x${string}`,
  expiration: number,
  amount: bigint,
  signedRelayerCommitment: `0x${string}`,
}

