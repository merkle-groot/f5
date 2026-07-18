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
