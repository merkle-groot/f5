import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AutomaticNoteActivator, countPending, planBackedActivations, MAX_FAST_FAILURES } from "./note-activator.mjs";

const state = (overrides = {}) => ({
  received: [],
  activated: [],
  activatedSupply: 0n,
  tokensReceived: 0n,
  ...overrides,
});

const silent = { log() {}, warn() {} };

describe("planBackedActivations", () => {
  it("nominates nothing when no tokens have bridged", () => {
    assert.deepEqual(planBackedActivations(state({ received: [{ commitment: 1n, value: 100n }] })), []);
  });

  it("nominates a note covered by the backing", () => {
    assert.deepEqual(
      planBackedActivations(state({ received: [{ commitment: 1n, value: 100n }], tokensReceived: 100n })),
      [{ commitment: 1n, value: 100n }],
    );
  });

  it("stops once the backing is consumed", () => {
    assert.deepEqual(
      planBackedActivations(
        state({
          received: [
            { commitment: 1n, value: 60n },
            { commitment: 2n, value: 60n },
          ],
          tokensReceived: 100n,
        }),
      ),
      [{ commitment: 1n, value: 60n }],
    );
  });

  it("keeps scanning past an oversized note to find one that fits", () => {
    assert.deepEqual(
      planBackedActivations(
        state({
          received: [
            { commitment: 1n, value: 500n },
            { commitment: 2n, value: 40n },
          ],
          tokensReceived: 100n,
        }),
      ),
      [{ commitment: 2n, value: 40n }],
    );
  });

  it("skips already-activated notes and subtracts their supply", () => {
    assert.deepEqual(
      planBackedActivations(
        state({
          received: [{ commitment: 1n, value: 50n }],
          activated: [{ commitment: 1n, value: 50n }],
          activatedSupply: 50n,
          tokensReceived: 100n,
        }),
      ),
      [],
    );
  });

  it("deduplicates a commitment seen twice across a reorg refetch", () => {
    assert.deepEqual(
      planBackedActivations(
        state({
          received: [
            { commitment: 1n, value: 40n },
            { commitment: 1n, value: 40n },
          ],
          tokensReceived: 100n,
        }),
      ),
      [{ commitment: 1n, value: 40n }],
    );
  });
});

describe("AutomaticNoteActivator", () => {
  const destination = { id: "evm:op", key: "op", label: "OP", pollMs: 1000 };

  it("asks the relayer to activate each nominated note", async () => {
    const activated = [];
    const activator = new AutomaticNoteActivator({
      getDestinations: () => [destination],
      scan: async () => state({ received: [{ commitment: 7n, value: 10n }], tokensReceived: 10n }),
      activate: async (_dest, note) => {
        activated.push(note.commitment);
        return { txHash: "0xabc" };
      },
      logger: silent,
    });

    await activator.tick(destination);
    assert.deepEqual(activated, [7n]);
  });

  it("keeps going when the relayer refuses one note", async () => {
    // Expected while a bridge transfer is still settling; the rest of the batch and
    // the next tick must not be abandoned.
    const attempted = [];
    const activator = new AutomaticNoteActivator({
      getDestinations: () => [destination],
      scan: async () =>
        state({
          received: [
            { commitment: 1n, value: 10n },
            { commitment: 2n, value: 10n },
          ],
          tokensReceived: 20n,
        }),
      activate: async (_dest, note) => {
        attempted.push(note.commitment);
        if (note.commitment === 1n) throw new Error("not backed yet");
        return { txHash: "0xok" };
      },
      logger: silent,
    });

    await activator.tick(destination);
    assert.deepEqual(attempted, [1n, 2n]);
  });

  it("survives a failed scan", async () => {
    const activator = new AutomaticNoteActivator({
      getDestinations: () => [destination],
      scan: async () => { throw new Error("RPC down"); },
      activate: async () => assert.fail("must not activate when the scan failed"),
      logger: silent,
    });

    await activator.tick(destination);
  });

  it("does not overlap ticks for one destination", async () => {
    let running = 0;
    let peak = 0;
    const activator = new AutomaticNoteActivator({
      getDestinations: () => [destination],
      scan: async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 20));
        running -= 1;
        return state();
      },
      activate: async () => ({}),
      logger: silent,
    });

    await Promise.all([activator.tick(destination), activator.tick(destination)]);
    assert.equal(peak, 1);
  });

  it("gives each destination its own timer", () => {
    const slow = { id: "starknet", key: "starknet", label: "Starknet", pollMs: 30_000 };
    const activator = new AutomaticNoteActivator({
      getDestinations: () => [destination, slow],
      scan: async () => state(),
      activate: async () => ({}),
      logger: silent,
    });

    activator.start();
    assert.equal(activator.timers.size, 2);
    activator.stop();
    assert.equal(activator.timers.size, 0);
  });
});

describe("countPending", () => {
  it("counts received notes that are not yet activated", () => {
    assert.equal(
      countPending({ received: [{ commitment: 1n }, { commitment: 2n }], activated: [{ commitment: 1n }] }),
      1,
    );
  });

  it("counts an unbacked note as pending", () => {
    // The pacing signal must be broader than planBackedActivations: a note whose
    // tokens have not landed is exactly when the scanner must NOT slow down.
    assert.equal(countPending({ received: [{ commitment: 9n }], activated: [] }), 1);
  });

  it("does not double-count a duplicated event", () => {
    assert.equal(countPending({ received: [{ commitment: 5n }, { commitment: 5n }], activated: [] }), 1);
  });

  it("is zero for a fully drained pool", () => {
    assert.equal(countPending({ received: [{ commitment: 3n }], activated: [{ commitment: 3n }] }), 0);
  });
});

describe("AutomaticNoteActivator pacing", () => {
  const dest = { id: "evm:op", key: "op", label: "OP", pollMs: 2_000, idlePollMs: 60_000, activeWindowMs: 900_000 };
  const build = (scan, clock) =>
    new AutomaticNoteActivator({
      getDestinations: () => [dest],
      scan,
      activate: async () => ({ txHash: "0x1" }),
      logger: silent,
      now: () => clock.t,
      setTimer: () => null,
      clearTimer: () => {},
    });

  it("drops to the idle cadence once nothing is pending", async () => {
    const clock = { t: 0 };
    const activator = build(async () => state(), clock);
    // Boot starts active so a cold process sees what is already in the pool...
    assert.equal(activator.intervalFor(dest), 2_000);
    await activator.tick(dest);
    // ...and settles as soon as the first scan comes back empty — one fast pass,
    // not a full active window on every restart.
    assert.equal(activator.intervalFor(dest), 60_000);
  });

  it("holds the active cadence while a note is pending", async () => {
    const clock = { t: 1_000_000 };
    const activator = build(
      async () => state({ received: [{ commitment: 4n, value: 5n }], tokensReceived: 0n }),
      clock,
    );
    await activator.tick(dest);
    // Unbacked, so nothing was activated — but it is precisely what we must watch.
    assert.equal(activator.intervalFor(dest), 2_000);
  });

  it("goes fast on a relay nudge and expires with the window", async () => {
    const clock = { t: 1_000_000 };
    const activator = build(async () => state(), clock);
    await activator.tick(dest);
    assert.equal(activator.intervalFor(dest), 60_000);

    activator.nudge();
    assert.equal(activator.intervalFor(dest), 2_000);

    clock.t += 900_001;
    assert.equal(activator.intervalFor(dest), 60_000);
  });

  it("does not slow down after a failed scan", async () => {
    // A scan that threw is not evidence of an empty pool.
    const clock = { t: 1_000_000 };
    const activator = build(
      async () => state({ received: [{ commitment: 1n, value: 5n }], tokensReceived: 0n }),
      clock,
    );
    await activator.tick(dest);
    assert.equal(activator.intervalFor(dest), 2_000);

    activator.scan = async () => { throw new Error("RPC down"); };
    await activator.tick(dest);
    assert.equal(activator.intervalFor(dest), 2_000);
  });

  it("never idles faster than the active cadence", () => {
    const odd = { ...dest, id: "x", pollMs: 30_000, idlePollMs: 1_000 };
    const activator = build(async () => state(), { t: 0 });
    assert.equal(activator.intervalFor(odd), 30_000);
  });
});

describe("AutomaticNoteActivator failure backoff", () => {
  const dest = { id: "evm:base", key: "base", label: "Base", pollMs: 2_000, idlePollMs: 60_000, activeWindowMs: 0 };
  const build = (scan) =>
    new AutomaticNoteActivator({
      getDestinations: () => [dest],
      scan,
      activate: async () => ({}),
      logger: silent,
      now: () => 1_000_000,
      setTimer: () => null,
      clearTimer: () => {},
    });

  it("stays fast through a couple of blips", async () => {
    const activator = build(async () => { throw new Error("blip"); });
    await activator.tick(dest);
    await activator.tick(dest);
    assert.equal(activator.intervalFor(dest), 2_000);
  });

  it("backs off a destination that keeps failing", async () => {
    // A misconfigured destination must not poll at block-time cadence forever.
    const activator = build(async () => { throw new Error("down"); });
    for (let i = 0; i < MAX_FAST_FAILURES; i += 1) await activator.tick(dest);
    assert.equal(activator.intervalFor(dest), 60_000);
  });

  it("returns to full speed once the destination recovers", async () => {
    const activator = build(async () => { throw new Error("down"); });
    for (let i = 0; i < MAX_FAST_FAILURES; i += 1) await activator.tick(dest);
    assert.equal(activator.intervalFor(dest), 60_000);

    activator.scan = async () => state({ received: [{ commitment: 1n, value: 5n }], tokensReceived: 0n });
    await activator.tick(dest);
    assert.equal(activator.intervalFor(dest), 2_000);
  });
});
