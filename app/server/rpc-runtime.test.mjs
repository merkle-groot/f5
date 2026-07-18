import assert from "node:assert/strict";
import test from "node:test";
import { measuredTransport, RpcMetrics, RpcRuntime } from "./rpc-runtime.mjs";

test("RpcRuntime reuses clients per logical chain and URL", () => {
  let created = 0;
  const runtime = new RpcRuntime({
    clientFactory: () => ({ id: ++created }),
  });
  assert.equal(runtime.client("evm:1", "https://one.invalid"), runtime.client("evm:1", "https://one.invalid"));
  assert.notEqual(runtime.client("evm:1", "https://one.invalid"), runtime.client("evm:1", "https://two.invalid"));
  assert.equal(created, 2);
});

test("head reads are cached and concurrent misses are coalesced", async () => {
  let now = 1000;
  let calls = 0;
  let release;
  const runtime = new RpcRuntime({
    now: () => now,
    headTtlMs: 100,
    clientFactory: () => ({
      getBlockNumber: async () => {
        calls += 1;
        await new Promise((resolve) => { release = resolve; });
        return 42n;
      },
    }),
  });

  const first = runtime.head("evm:1", "https://rpc.invalid");
  const concurrent = runtime.head("evm:1", "https://rpc.invalid");
  release();
  assert.equal(await first, 42n);
  assert.equal(await concurrent, 42n);
  assert.equal(calls, 1);
  assert.equal(await runtime.head("evm:1", "https://rpc.invalid"), 42n);
  assert.equal(calls, 1);

  now += 101;
  const expired = runtime.head("evm:1", "https://rpc.invalid");
  release();
  assert.equal(await expired, 42n);
  assert.equal(calls, 2);
  assert.deepEqual(runtime.snapshot().cache, {
    headHits: 1,
    headMisses: 2,
    headCoalesced: 1,
    eventHits: 0,
    eventMisses: 0,
    eventCoalesced: 0,
    readHits: 0,
    readMisses: 0,
    readCoalesced: 0,
  });
});

test("cached reads honor TTL and coalesce concurrent loaders", async () => {
  let now = 0;
  let calls = 0;
  let release;
  const runtime = new RpcRuntime({ now: () => now, clientFactory: () => ({}) });
  const load = async () => {
    calls += 1;
    await new Promise((resolve) => { release = resolve; });
    return calls;
  };
  const first = runtime.cachedRead("scope:1", load, { maxAgeMs: 10 });
  const second = runtime.cachedRead("scope:1", load, { maxAgeMs: 10 });
  await Promise.resolve();
  release();
  assert.equal(await first, 1);
  assert.equal(await second, 1);
  assert.equal(await runtime.cachedRead("scope:1", load, { maxAgeMs: 10 }), 1);
  now = 11;
  const expired = runtime.cachedRead("scope:1", load, { maxAgeMs: 10 });
  await Promise.resolve();
  release();
  assert.equal(await expired, 2);
  assert.equal(calls, 2);
  assert.equal(runtime.snapshot().cache.readHits, 1);
  assert.equal(runtime.snapshot().cache.readMisses, 2);
  assert.equal(runtime.snapshot().cache.readCoalesced, 1);
});

test("measured transport records calls, failures, and rate limits without params", async () => {
  let time = 0;
  const metrics = new RpcMetrics({ now: () => 0 });
  const base = () => ({
    request: async ({ method }) => {
      if (method === "eth_getLogs") throw Object.assign(new Error("429 Too Many Requests"), { status: 429 });
      return "0x1";
    },
  });
  const transport = measuredTransport(base, "evm:1", metrics, { clock: () => ++time })({});
  assert.equal(await transport.request({ method: "eth_blockNumber", params: [] }), "0x1");
  await assert.rejects(() => transport.request({ method: "eth_getLogs", params: [] }), /429/);
  const snapshot = metrics.snapshot();
  assert.deepEqual(snapshot.totals, { calls: 2, errors: 1, rateLimited: 1 });
  assert.equal(JSON.stringify(snapshot).includes("params"), false);
});
