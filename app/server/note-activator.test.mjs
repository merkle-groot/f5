import assert from "node:assert/strict";
import test from "node:test";
import { AutomaticNoteActivator, KeyedSerialExecutor, planBackedActivations } from "./note-activator.mjs";

test("plans unactivated notes in receipt order without exceeding available backing", () => {
  const planned = planBackedActivations({
    received: [
      { commitment: 1n, value: 4n },
      { commitment: 2n, value: 7n },
      { commitment: 3n, value: 2n },
      { commitment: 3n, value: 2n },
      { commitment: 4n, value: 1n },
    ],
    activated: [{ commitment: 1n, value: 4n }],
    activatedSupply: 4n,
    tokensReceived: 8n,
  });

  assert.deepEqual(planned.map((event) => event.commitment), [3n, 4n]);
});

test("plans nothing when the pool has no unused backing", () => {
  assert.deepEqual(planBackedActivations({
    received: [{ commitment: 1n, value: 1n }],
    activated: [],
    activatedSupply: 5n,
    tokensReceived: 5n,
  }), []);
});

test("coalesces overlapping ticks and contains per-destination failures", async () => {
  let release;
  let calls = 0;
  const warnings = [];
  const activator = new AutomaticNoteActivator({
    getDestinations: () => [{ id: "op" }, { id: "base" }],
    refresh: async ({ id }) => {
      calls += 1;
      if (id === "base") throw new Error("offline");
      await new Promise((resolve) => { release = resolve; });
    },
    logger: { warn: (...args) => warnings.push(args) },
  });

  const first = activator.tick();
  await Promise.resolve();
  const second = activator.tick();
  assert.equal(first, second);
  release();
  await first;

  assert.equal(calls, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].join(" "), /base failed/);
});

test("serializes signer work by key and continues after a failed transaction", async () => {
  const executor = new KeyedSerialExecutor();
  const order = [];
  let release;
  const first = executor.run("op:relayer", async () => {
    order.push("first:start");
    await new Promise((resolve) => { release = resolve; });
    order.push("first:end");
    throw new Error("reverted");
  });
  const second = executor.run("op:relayer", async () => { order.push("second"); });
  const otherChain = executor.run("base:relayer", async () => { order.push("base"); });

  await otherChain;
  assert.deepEqual(order, ["first:start", "base"]);
  release();
  await assert.rejects(first, /reverted/);
  await second;
  assert.deepEqual(order, ["first:start", "base", "first:end", "second"]);
});
