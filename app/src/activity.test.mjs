import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildActivity, relativeTime } from "./activity.js";

const label = (key) => ({ op: "OP Sepolia", "11155420": "OP Sepolia", starknet: "Starknet" })[key] ?? key;

describe("buildActivity", () => {
  it("returns nothing for an empty vault", () => {
    assert.deepEqual(buildActivity(), []);
    assert.deepEqual(buildActivity([], {}), []);
  });

  it("records a live note as a deposit only", () => {
    const entries = buildActivity([{ index: "0", value: "1000", status: "ready", depositedAt: 5, depositHash: "0xaa" }], {}, label);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, "deposit");
    assert.equal(entries[0].hash, "0xaa");
    assert.match(entries[0].detail, /note #0/);
  });

  it("records a spent note as both its deposit and its bridge", () => {
    const entries = buildActivity([{
      index: "1", value: "1000", status: "spent",
      depositedAt: 10, spentAt: 20, spentTo: "11155420", spentHash: "0xbb",
    }], {}, label);
    assert.deepEqual(entries.map((e) => e.kind), ["bridge", "deposit"]);
    assert.match(entries[0].detail, /to OP Sepolia/);
    assert.equal(entries[0].hash, "0xbb");
  });

  // A ragequit is not a bridge and must never be described as one — it is the
  // public exit, and the log is where a user checks what became public.
  it("distinguishes a ragequit from a bridge", () => {
    const entries = buildActivity([{
      index: "2", value: "1000", status: "spent",
      spentBy: "ragequit", ragequitHash: "0xcc", depositedAt: 1, spentAt: 2,
    }], {}, label);
    assert.deepEqual(entries.map((e) => e.kind), ["ragequit", "deposit"]);
    assert.equal(entries[0].hash, "0xcc");
    assert.ok(!entries.some((e) => e.kind === "bridge"));
  });

  it("includes L2 withdrawals with their recipient", () => {
    const entries = buildActivity([], { "99": { value: "500", chain: "op", recipient: "0xdead", hash: "0xdd", at: 7 } }, label);
    assert.equal(entries[0].kind, "withdraw");
    assert.equal(entries[0].id, "99");
    assert.match(entries[0].detail, /OP Sepolia → 0xdead/);
  });

  it("orders every source together, newest first", () => {
    const entries = buildActivity(
      [{ index: "0", value: "1", status: "spent", depositedAt: 100, spentAt: 300, spentTo: "op" }],
      { a: { value: "1", chain: "op", at: 200 } },
      label,
    );
    assert.deepEqual(entries.map((e) => e.at), [300, 200, 100]);
  });

  // Recovered notes carry no local annotations, so they must still appear rather
  // than vanishing from the log the moment a scan rebuilds them.
  it("keeps undated events, sorted after everything dated", () => {
    const entries = buildActivity(
      [{ index: "0", value: "1", status: "ready" }, { index: "1", value: "2", status: "ready", depositedAt: 50 }],
      {},
      label,
    );
    assert.equal(entries.length, 2);
    assert.equal(entries[0].at, 50);
    assert.equal(entries[1].at, null);
  });

  it("labels a legacy note as such", () => {
    const entries = buildActivity([{ value: "1", status: "ready", legacy: true }], {}, label);
    assert.match(entries[0].detail, /legacy/);
  });
});

describe("relativeTime", () => {
  const now = 1_000_000_000;
  it("describes recent, minute, hour, and day scales", () => {
    assert.equal(relativeTime(now - 5_000, now), "just now");
    assert.equal(relativeTime(now - 120_000, now), "2m ago");
    assert.equal(relativeTime(now - 7_200_000, now), "2h ago");
    assert.equal(relativeTime(now - 172_800_000, now), "2d ago");
  });

  it("says nothing for an undated event", () => {
    assert.equal(relativeTime(null, now), "");
    assert.equal(relativeTime(0, now), "");
  });
});
