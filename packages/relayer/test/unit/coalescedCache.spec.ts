import { describe, expect, it } from "vitest";
import { CoalescedTtlCache } from "../../src/utils/coalescedCache.js";

describe("CoalescedTtlCache", () => {
  it("coalesces concurrent loads and refreshes after the TTL", async () => {
    let now = 0;
    let calls = 0;
    let release!: () => void;
    const cache = new CoalescedTtlCache<string, number>(10, () => now);
    const loader = async () => {
      calls += 1;
      await new Promise<void>((resolve) => { release = resolve; });
      return calls;
    };

    const first = cache.get("gas:1", loader);
    const concurrent = cache.get("gas:1", loader);
    release();
    await expect(first).resolves.toBe(1);
    await expect(concurrent).resolves.toBe(1);
    await expect(cache.get("gas:1", loader)).resolves.toBe(1);
    expect(calls).toBe(1);

    now = 11;
    const expired = cache.get("gas:1", loader);
    release();
    await expect(expired).resolves.toBe(2);
    expect(calls).toBe(2);
  });

  /**
   * `force` means "do not give me a value that was read before I asked". Returning an
   * already in-flight load satisfies neither that nor the TTL check it bypasses.
   */
  it("a forced read does not join a load that was already in flight", async () => {
    const cache = new CoalescedTtlCache<string, number>(1_000);
    let calls = 0;
    const releases: Array<() => void> = [];
    const loader = async () => {
      calls += 1;
      const mine = calls;
      await new Promise<void>((resolve) => releases.push(resolve));
      return mine;
    };

    const inFlight = cache.get("gas:1", loader);
    const forced = cache.get("gas:1", loader, { force: true });
    expect(calls).toBe(2);

    releases.forEach((release) => release());
    await expect(inFlight).resolves.toBe(1);
    await expect(forced).resolves.toBe(2);
  });

  it("does not cache rejected loads", async () => {
    const cache = new CoalescedTtlCache<string, number>(100);
    let calls = 0;
    await expect(cache.get("x", async () => {
      calls += 1;
      throw new Error("temporary");
    })).rejects.toThrow("temporary");
    await expect(cache.get("x", async () => ++calls)).resolves.toBe(2);
  });
});
