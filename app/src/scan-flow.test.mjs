import assert from "node:assert/strict";
import test from "node:test";
import { runSequentialScan } from "./scan-flow.js";

test("runSequentialScan waits for each route before starting the next", async () => {
  const events = [];
  let active = 0;
  let maxActive = 0;
  const makeStep = (key) => ({
    key,
    async run() {
      events.push(`start:${key}`);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      events.push(`end:${key}`);
      return { detail: `${key} complete` };
    },
  });

  const results = await runSequentialScan([
    makeStep("l1"),
    makeStep("optimism"),
    makeStep("base"),
  ]);

  assert.equal(maxActive, 1);
  assert.deepEqual(events, [
    "start:l1", "end:l1",
    "start:optimism", "end:optimism",
    "start:base", "end:base",
  ]);
  assert.deepEqual(results.map(({ step, status }) => [step.key, status]), [
    ["l1", "complete"],
    ["optimism", "complete"],
    ["base", "complete"],
  ]);
});

test("runSequentialScan reports a route error and continues when requested", async () => {
  const updates = [];
  const visited = [];

  const results = await runSequentialScan([
    {
      key: "l1",
      continueOnError: true,
      async run() { visited.push("l1"); throw new Error("L1 unavailable"); },
    },
    {
      key: "base",
      async run() { visited.push("base"); return { detail: "2 candidates" }; },
    },
  ], {
    onStep(step, update) { updates.push([step.key, update.status]); },
  });

  assert.deepEqual(visited, ["l1", "base"]);
  assert.deepEqual(updates, [
    ["l1", "scanning"],
    ["l1", "error"],
    ["base", "scanning"],
    ["base", "complete"],
  ]);
  assert.deepEqual(results.map(({ step, status }) => [step.key, status]), [
    ["l1", "error"],
    ["base", "complete"],
  ]);
});
