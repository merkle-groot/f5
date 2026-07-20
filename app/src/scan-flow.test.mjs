import assert from "node:assert/strict";
import test from "node:test";
import { preservedNotes, runSequentialScan } from "./scan-flow.js";

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

const note = (chain, cDest, status = "activate") => ({ chain, cDest, _status: status, value: 1n });

test("preservedNotes keeps notes on routes a partial scan never visited", () => {
  const previous = [note("op", 1), note("base", 2), note("arb", 3)];
  // A rescan of just OP: only OP may be replaced by the fresh results.
  const keep = preservedNotes({ previous, fresh: [note("op", 9)], refreshedRoutes: ["l1", "op"] });
  assert.deepEqual(keep.map((n) => `${n.chain}:${n.cDest}`), ["base:2", "arb:3"]);
});

test("preservedNotes keeps notes on a route that failed", () => {
  const previous = [note("op", 1), note("base", 2)];
  // Base errored, so it is absent from refreshedRoutes and must not be emptied.
  const keep = preservedNotes({ previous, fresh: [note("op", 1)], refreshedRoutes: ["l1", "op"] });
  assert.deepEqual(keep.map((n) => n.chain), ["base"]);
});

test("preservedNotes drops a note the refreshed route no longer reports", () => {
  // OP completed and did not return note 1 — it is genuinely gone, not unknown.
  const keep = preservedNotes({ previous: [note("op", 1)], fresh: [], refreshedRoutes: ["op"] });
  assert.deepEqual(keep, []);
});

test("preservedNotes never duplicates a note the scan already found", () => {
  const keep = preservedNotes({ previous: [note("op", 1)], fresh: [note("op", 1)], refreshedRoutes: [] });
  assert.deepEqual(keep, []);
});

test("preservedNotes keeps an in-flight self-bridge even on a completed route", () => {
  // The destination cannot see a pending bridge yet, so a successful scan of that
  // very route must not erase it.
  const previous = [note("op", 1, "pending")];
  const keep = preservedNotes({ previous, fresh: [], refreshedRoutes: ["op"] });
  assert.deepEqual(keep.map((n) => n._status), ["pending"]);
});

test("preservedNotes yields the live note once a pending bridge lands", () => {
  // Same chain and C_dest arriving fresh: the delivered note wins, no duplicate.
  const keep = preservedNotes({
    previous: [note("op", 1, "pending")],
    fresh: [note("op", 1, "spendable")],
    refreshedRoutes: ["op"],
  });
  assert.deepEqual(keep, []);
});

test("preservedNotes keeps everything when a scan completes no routes at all", () => {
  const previous = [note("op", 1), note("base", 2)];
  assert.equal(preservedNotes({ previous, fresh: [], refreshedRoutes: [] }).length, 2);
});
