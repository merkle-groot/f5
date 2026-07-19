import { describe, expect, it } from "vitest";
import { KeyedSerialExecutor } from "../../src/utils/keyedSerialExecutor.js";

/** Let every queued microtask run before asserting on observable ordering. */
const drainMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("KeyedSerialExecutor", () => {
  it("runs tasks with the same key one at a time", async () => {
    const executor = new KeyedSerialExecutor();
    const first = deferred<string>();
    const order: string[] = [];

    const a = executor.run("signer", async () => {
      order.push("a:start");
      const value = await first.promise;
      order.push("a:end");
      return value;
    });
    const b = executor.run("signer", async () => {
      order.push("b:start");
      return "b";
    });

    // Tasks start asynchronously (`.catch().then()` is two microtask hops, not one),
    // so drain the queue before asserting on what has run.
    await drainMicrotasks();
    // `b` must not have started while `a` is still in flight — this is the nonce
    // guarantee the whole class exists for.
    expect(order).toEqual(["a:start"]);
    first.resolve("a");
    await Promise.all([a, b]);
    expect(order).toEqual(["a:start", "a:end", "b:start"]);
  });

  it("runs tasks with different keys concurrently", async () => {
    const executor = new KeyedSerialExecutor();
    const blocker = deferred<string>();
    const order: string[] = [];

    const a = executor.run("op", async () => {
      order.push("op:start");
      return blocker.promise;
    });
    const b = executor.run("base", async () => {
      order.push("base:start");
      return "base";
    });

    await b;
    await drainMicrotasks();
    expect(order.sort()).toEqual(["base:start", "op:start"]);
    blocker.resolve("op");
    await a;
  });

  it("does not let a failed task poison the queue", async () => {
    const executor = new KeyedSerialExecutor();

    const failing = executor.run("signer", async () => {
      throw new Error("reverted");
    });
    const next = executor.run("signer", async () => "ok");

    await expect(failing).rejects.toThrow("reverted");
    await expect(next).resolves.toBe("ok");
  });

  it("still rejects for the caller that owns the failing task", async () => {
    const executor = new KeyedSerialExecutor();
    await expect(
      executor.run("signer", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
