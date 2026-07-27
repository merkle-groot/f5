import assert from "node:assert/strict";
import test from "node:test";
import { L1SpendSnapshot } from "./l1-spend-snapshot.mjs";

test("builds one deduplicated public snapshot for withdrawals and ragequits", async () => {
  const index = new L1SpendSnapshot({
    now: () => 1234,
    read: async () => ({
      withdrawals: [
        { args: { _spentNullifier: 1n } },
        { args: { _spentNullifier: 1n } },
        { args: { _spentNullifier: 2n } },
      ],
      ragequits: [
        { args: { _commitment: 3n } },
        { args: { _commitment: 3n } },
      ],
    }),
  });

  assert.deepEqual(await index.refresh(), {
    nullifiers: ["1", "2"],
    ragequitCommitments: ["3"],
    updatedAt: 1234,
  });
  assert.deepEqual(index.snapshot(), {
    nullifiers: ["1", "2"],
    ragequitCommitments: ["3"],
    updatedAt: 1234,
  });
});

test("coalesces concurrent refreshes so a client burst cannot multiply RPC work", async () => {
  let calls = 0;
  let release;
  const index = new L1SpendSnapshot({
    read: async () => {
      calls += 1;
      await new Promise((resolve) => { release = resolve; });
      return { withdrawals: [], ragequits: [] };
    },
  });

  const first = index.refresh();
  const burst = Array.from({ length: 20 }, () => index.refresh());
  await Promise.resolve();
  release();
  await Promise.all([first, ...burst]);
  assert.equal(calls, 1);
});

test("keeps the last good snapshot when a later background refresh fails", async () => {
  let fail = false;
  const warnings = [];
  const index = new L1SpendSnapshot({
    logger: { warn: (...args) => warnings.push(args) },
    read: async () => {
      if (fail) throw new Error("RPC unavailable");
      return { withdrawals: [{ args: { _spentNullifier: 9n } }], ragequits: [] };
    },
  });

  const good = await index.refresh();
  fail = true;
  assert.equal(await index.refresh(), good);
  assert.equal(index.snapshot(), good);
  assert.equal(warnings.length, 1);
});

test("rejects a snapshot older than two scan intervals", async () => {
  let now = 0;
  const index = new L1SpendSnapshot({
    intervalMs: 5_000,
    now: () => now,
    read: async () => ({ withdrawals: [], ragequits: [] }),
  });

  await index.refresh();
  now = 10_001;
  assert.equal(index.isFresh(), false);
});
