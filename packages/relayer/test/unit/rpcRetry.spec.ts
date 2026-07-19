import { describe, expect, it, vi } from "vitest";
import { isRetryableRpcError, retryRpc } from "../../src/utils/rpcRetry.js";

const noSleep = { sleep: async () => {}, random: () => 0.5 };

describe("isRetryableRpcError", () => {
  it("treats the -32603 blip as retryable", () => {
    // This exact code is what made a correctly configured Starknet pool look broken
    // (FIXES.md); it must never fail a relay on the first try.
    expect(isRetryableRpcError({ code: -32603 })).toBe(true);
  });

  it("treats rate limits and 5xx as retryable", () => {
    expect(isRetryableRpcError({ status: 429 })).toBe(true);
    expect(isRetryableRpcError({ status: 503 })).toBe(true);
    expect(isRetryableRpcError({ message: "Too Many Requests" })).toBe(true);
  });

  it("treats transient socket errors as retryable", () => {
    expect(isRetryableRpcError({ code: "ECONNRESET" })).toBe(true);
    expect(isRetryableRpcError({ code: "UND_ERR_CONNECT_TIMEOUT" })).toBe(true);
  });

  it("finds a retryable cause nested inside a viem error", () => {
    expect(isRetryableRpcError({ message: "call failed", cause: { code: -32603 } })).toBe(true);
  });

  it("does not retry a deterministic failure", () => {
    // -32602 is Alchemy rejecting the `pending` block tag: retrying never helps.
    expect(isRetryableRpcError({ code: -32602, message: "Invalid block id" })).toBe(false);
    expect(isRetryableRpcError(new Error("execution reverted"))).toBe(false);
  });

  it("terminates on a cyclic cause chain", () => {
    const error: Record<string, unknown> = { message: "nope" };
    error.cause = error;
    expect(isRetryableRpcError(error)).toBe(false);
  });
});

describe("retryRpc", () => {
  it("returns the first successful result without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(retryRpc(fn, noSleep)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure and then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ code: -32603 })
      .mockResolvedValue("ok");
    await expect(retryRpc(fn, noSleep)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up after the attempt budget and rethrows", async () => {
    const fn = vi.fn().mockRejectedValue({ code: -32603, message: "unavailable" });
    await expect(retryRpc(fn, { ...noSleep, attempts: 3 })).rejects.toMatchObject({ code: -32603 });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-retryable error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("execution reverted"));
    await expect(retryRpc(fn, noSleep)).rejects.toThrow("execution reverted");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("honours a retry-after header over its own backoff", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi
      .fn()
      .mockRejectedValueOnce({
        status: 429,
        headers: { get: (name: string) => (name === "retry-after" ? "2" : null) },
      })
      .mockResolvedValue("ok");

    await retryRpc(fn, { sleep, random: () => 0.5 });
    expect(sleep).toHaveBeenCalledWith(2000);
  });
});
