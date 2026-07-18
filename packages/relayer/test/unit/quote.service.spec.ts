import { describe, expect, it, vi } from "vitest";

// `netFeeBPSNative` is pure arithmetic; stub the providers barrel so importing the
// service doesn't pull in config.json loading at module init.
vi.mock("../../src/providers/index.js", () => ({
  web3Provider: { getGasPrice: vi.fn() },
  quoteProvider: { quoteNativeTokenInERC20: vi.fn() },
  getSdkProvider: vi.fn(),
}));

import { QuoteService } from "../../src/services/quote.service.js";

describe("QuoteService.netFeeBPSNative bridge fee", () => {
  const svc = new QuoteService();
  const baseFee = 0n;
  const balance = 1_000_000_000_000_000_000n; // 1 ETH withdrawn
  const nativeQuote = { num: 1n, den: 1n }; // native asset, 1:1
  const gasPrice = 1_000_000_000n; // 1 gwei
  const extraGasUnits = 0n;

  it("adds nothing for an OP-Stack destination (bridgeFee = 0)", async () => {
    const withZero = await svc.netFeeBPSNative(baseFee, balance, nativeQuote, gasPrice, extraGasUnits, 0n);
    const withDefault = await svc.netFeeBPSNative(baseFee, balance, nativeQuote, gasPrice, extraGasUnits);
    expect(withZero).toEqual(withDefault);
  });

  it("prices a fronted L1->L2 fee into the quote (Arbitrum/Starknet)", async () => {
    const bridgeFeeWei = 500_000_000_000_000n; // 0.0005 ETH
    const withoutFee = await svc.netFeeBPSNative(baseFee, balance, nativeQuote, gasPrice, extraGasUnits, 0n);
    const withFee = await svc.netFeeBPSNative(baseFee, balance, nativeQuote, gasPrice, extraGasUnits, bridgeFeeWei);

    // The fronted fee raises the quoted BPS by exactly its share of the withdrawn balance.
    const expectedDelta = (1n * 10_000n * bridgeFeeWei) / balance;
    expect(withFee - withoutFee).toEqual(expectedDelta);
    expect(withFee).toBeGreaterThan(withoutFee);
  });
});
