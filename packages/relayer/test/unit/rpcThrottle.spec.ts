import { describe, expect, it } from "vitest";
import { KeyedConcurrencyLimiter } from "../../src/utils/rpcThrottle.js";

const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

describe("KeyedConcurrencyLimiter", () => {
  it("never exceeds the limit for one key", async () => {
    const limiter = new KeyedConcurrencyLimiter(2);
    let active = 0;
    let peak = 0;
    const blockers = Array.from({ length: 5 }, () => deferred<void>());

    const runs = blockers.map((blocker) =>
      limiter.run("rpc", async () => {
        active += 1;
        peak = Math.max(peak, active);
        await blocker.promise;
        active -= 1;
      }),
    );

    await drain();
    expect(peak).toBe(2);

    for (const blocker of blockers) {
      blocker.resolve();
      await drain();
    }
    await Promise.all(runs);
    expect(peak).toBe(2);
  });

  it("serializes fully at a limit of 1", async () => {
    const limiter = new KeyedConcurrencyLimiter(1);
    const order: number[] = [];
    const blocker = deferred<void>();

    const first = limiter.run("rpc", async () => {
      order.push(1);
      await blocker.promise;
    });
    const second = limiter.run("rpc", async () => {
      order.push(2);
    });

    await drain();
    expect(order).toEqual([1]);
    blocker.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
  });

  it("does not let one key block another", async () => {
    const limiter = new KeyedConcurrencyLimiter(1);
    const blocker = deferred<void>();
    const order: string[] = [];

    const slow = limiter.run("endpoint-a", async () => {
      order.push("a");
      await blocker.promise;
    });
    await limiter.run("endpoint-b", async () => {
      order.push("b");
    });

    expect(order).toEqual(["a", "b"]);
    blocker.resolve();
    await slow;
  });

  it("releases the slot when a call throws", async () => {
    const limiter = new KeyedConcurrencyLimiter(1);
    await expect(
      limiter.run("rpc", async () => {
        throw new Error("rate limited");
      }),
    ).rejects.toThrow("rate limited");

    // A leaked slot would deadlock every later call on this key.
    await expect(limiter.run("rpc", async () => "ok")).resolves.toBe("ok");
  });
});
