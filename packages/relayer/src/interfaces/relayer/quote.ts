export interface QuotetBody {
  /** Chain ID to process the request on (where the pool/relay lives, e.g. L1) */
  chainId: string | number;
  /**
   * Destination chain the note is bridged to (`withdrawal.chainId`). Optional:
   * when set, the quote also covers the L1->L2 message/gas fee the relayer fronts
   * for that destination (non-zero for Arbitrum/Starknet, zero for OP-Stack).
   */
  destinationChainId?: string | number;
  /** Potential balance to withdraw */
  amount: string;
  /** Asset address */
  asset: string;
  /** Asset address */
  recipient?: string;
  /** Extra gas flag */
  extraGas: boolean;
}

export interface QuoteResponse {
  baseFeeBPS: bigint,
  feeBPS: bigint,
  gasPrice: bigint,
  detail: { [key: string]: { gas: bigint, eth: bigint; } | undefined; };
  feeCommitment?: {
    expiration: number,
    withdrawalData: `0x${string}`,
    amount: string,
    extraGas: boolean,
    signedRelayerCommitment: `0x${string}`,
  };
}
