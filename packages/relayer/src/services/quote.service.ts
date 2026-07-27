import { Address } from "viem";
import { ValidationError } from "../exceptions/base.exception.js";
import { web3Provider } from "../providers/index.js";

interface QuoteFeeBPSParams {
  chainId: number,
  assetAddress: Address,
  amountIn: bigint,
  baseFeeBPS: bigint,
  /**
   * L1->L2 bridge fee (in native wei) the relayer fronts for the destination.
   * Zero for OP-Stack; non-zero for Arbitrum/Starknet. Priced into the fee so the
   * relayer is reimbursed for the fronted `msg.value`. Defaults to 0.
   */
  bridgeFeeWei?: bigint;
};

const NativeAddress = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

export interface QuoteFee {
  feeBPS: bigint;
  path: (string | number)[];
  gasPrice: bigint;
  relayTxCost: bigint;
};

export class QuoteService {

  readonly relayTxCost: bigint;

  constructor() {
    // a typical withdrawal costs between 450k-650k gas
    this.relayTxCost = 650_000n;
  }

  async netFeeBPSNative(baseFee: bigint, balance: bigint, nativeQuote: { num: bigint, den: bigint; }, gasPrice: bigint, bridgeFeeWei: bigint = 0n): Promise<bigint> {
    // `balance` is the withdrawn amount the costs are spread over, and it divides
    // below. A zero (or negative) amount is a malformed request, and letting it
    // through raises a bare `RangeError: Division by zero` that surfaces as a 500
    // rather than the validation failure it actually is.
    if (balance <= 0n) {
      throw ValidationError.invalidInput({
        message: `Cannot quote a relay fee for a non-positive amount (got ${balance}).`,
      });
    }
    const totalGasUnits = this.relayTxCost;
    // The fronted L1->L2 bridge fee is already a native amount; add it alongside gas costs.
    const nativeCosts = (1n * gasPrice * totalGasUnits) + bridgeFeeWei;
    return baseFee + nativeQuote.den * 10_000n * nativeCosts / balance / nativeQuote.num;
  }

  async quoteFeeBPSNative(quoteParams: QuoteFeeBPSParams): Promise<QuoteFee> {
    const { chainId, assetAddress, amountIn, baseFeeBPS, bridgeFeeWei = 0n } = quoteParams;
    const gasPrice = await web3Provider.getGasPrice(chainId);

    // f5 is a native-ETH pool (CLAUDE.md §1). The fee is denominated in the same
    // currency as gas, so the quote needs no price conversion and the num/den pair
    // is always 1:1. An ERC20 pool would need an oracle here; the Uniswap quoter
    // that used to fill that role was removed along with the `extraGas` swap path.
    if (assetAddress.toLowerCase() !== NativeAddress.toLowerCase()) {
      throw ValidationError.invalidInput({
        message: `f5 relays native ETH only; cannot quote asset ${assetAddress}.`,
      });
    }
    const quote = { num: 1n, den: 1n, path: [] as (string | number)[] };

    const feeBPS = await this.netFeeBPSNative(baseFeeBPS, amountIn, quote, gasPrice, bridgeFeeWei);

    return {
      feeBPS,
      gasPrice,
      relayTxCost: this.relayTxCost,
      path: quote.path
    };
  }

}
