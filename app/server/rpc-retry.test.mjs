import assert from "node:assert/strict";
import test from "node:test";
import { isRetryableRpcError, retryRpc } from "./rpc-retry.mjs";

test("does not retry permanent JSON-RPC errors", async () => {
  let calls = 0;
  await assert.rejects(() => retryRpc(async () => {
    calls += 1;
    throw Object.assign(new Error("Invalid block id"), { code: -32602 });
  }, { sleep: async () => {} }), /Invalid block id/);
  assert.equal(calls, 1);
});
test("retries temporary internal errors with exponential jitter", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await retryRpc(async () => {
    calls += 1;
    if (calls < 3) throw Object.assign(new Error("service temporarily unavailable"), { code: -32603 });
    return "ok";
  }, { baseDelayMs: 100, random: () => 0.5, sleep: async (ms) => sleeps.push(ms) });
  assert.equal(result, "ok");
  assert.deepEqual(sleeps, [100, 200]);
});

test("honors Retry-After for 429 responses", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await retryRpc(async () => {
    calls += 1;
    if (calls === 1) {
      throw Object.assign(new Error("rate limited"), {
        status: 429,
        response: { headers: { get: () => "2" } },
      });
    }
    return 7;
  }, { sleep: async (ms) => sleeps.push(ms) });
  assert.equal(result, 7);
  assert.deepEqual(sleeps, [2000]);
  assert.equal(isRetryableRpcError(Object.assign(new Error("bad params"), { code: -32602 })), false);
});
