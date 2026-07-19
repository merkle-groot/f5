/**
 * Choose pending notes that can be activated without exceeding the pool's remaining
 * bridge backing (CLAUDE.md §6: `spendableShieldedSupply <= tokensReceivedFromBridge`).
 *
 * This is a NOMINATION, not a decision. The relayer re-checks each candidate against
 * fresh chain state before signing, and the pool checks it authoritatively again. The
 * point of doing it here is to avoid asking the relayer to spend gas on notes we can
 * already see are unbacked.
 */
export function planBackedActivations({ received, activated, activatedSupply, tokensReceived }) {
  const alreadyActivated = new Set(activated.map((event) => String(event.commitment)));
  const seen = new Set();

  let available = BigInt(tokensReceived) - BigInt(activatedSupply);
  if (available <= 0n) return [];

  const planned = [];
  for (const event of received) {
    const commitment = String(event.commitment);
    if (seen.has(commitment) || alreadyActivated.has(commitment)) continue;
    seen.add(commitment);

    const value = BigInt(event.value);
    // `continue`, not `break`: a later, smaller note may still fit inside the
    // remaining backing, and skipping it would strand a spendable note as pending.
    if (value <= 0n || value > available) continue;

    planned.push({ commitment: BigInt(event.commitment), value });
    available -= value;
  }
  return planned;
}

/**
 * Consecutive failed scans tolerated at the fast cadence before backing off.
 * A transient RPC blip must not add latency; a dead endpoint must not burn quota.
 */
export const MAX_FAST_FAILURES = 3;

/**
 * Notes the pool has received but not yet activated.
 *
 * This is the signal the scanner paces itself on, and it is deliberately broader than
 * `planBackedActivations`: a note whose tokens have not landed yet is not activatable,
 * but it is the strongest possible evidence that something IS about to become
 * activatable. Counting only backed notes would make the scanner slow down at exactly
 * the moment it should stay fast.
 */
export function countPending({ received, activated }) {
  const done = new Set(activated.map((event) => String(event.commitment)));
  const seen = new Set();
  let pending = 0;
  for (const event of received) {
    const id = String(event.commitment);
    if (seen.has(id) || done.has(id)) continue;
    seen.add(id);
    pending += 1;
  }
  return pending;
}

/**
 * Scans destinations for backed pending notes and asks the relayer to activate them.
 *
 * The app server owns discovery because it already owns the indexing stack (event
 * cursors, head coalescing, per-chain concurrency limits) and already reads these
 * exact events to serve `/api/l2/:chain/index`. Running the scan here reuses that work
 * instead of duplicating it in a second process; the relayer holds the keys and does
 * the signing.
 *
 * ## Pacing
 *
 * Each destination has its own schedule, and each schedule has two speeds:
 *
 * - **active** (`pollMs`, derived from the chain's block time) whenever there is
 *   something to watch;
 * - **idle** (`idlePollMs`, much slower) when there is not.
 *
 * A fixed fast interval spends its entire budget proving that nothing happened —
 * an idle system polling four destinations every 2s burns millions of RPC requests a
 * month to discover nothing. The dominant input to that bill is wall-clock time, not
 * users, so the fix has to be temporal.
 *
 * Two things make a destination active:
 *
 * 1. **Pending notes exist.** Self-regulating and the reason this is safe: a note the
 *    pool has received stays visible until it is activated, so once anything is
 *    in flight the scanner holds its fast cadence until the work is finished, then
 *    settles back down on its own.
 * 2. **`nudge()`** — an L1 relay just passed through the proxy, so a note is inbound
 *    but has not yet appeared on the destination. This only shortens the discovery
 *    gap; correctness never depends on it, which matters because a relay submitted
 *    directly to the relayer bypasses the app server entirely. In that case the idle
 *    heartbeat finds the note and signal (1) takes over.
 */
export class AutomaticNoteActivator {
  constructor({
    getDestinations,
    scan,
    activate,
    logger = console,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    this.getDestinations = getDestinations;
    this.scan = scan;
    this.activate = activate;
    this.logger = logger;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timers = new Map();
    this.inFlight = new Map();
    this.states = new Map();
  }

  state(destination) {
    let state = this.states.get(destination.id);
    if (!state) {
      // `scanned: false` makes a cold process active until its FIRST scan reports
      // back — we have no idea what is already sitting in the pool. Seeding
      // `activeUntil` instead would hold the fast cadence for a whole window on
      // every restart, which is a recurring cost for a one-off question.
      state = { pending: 0, activeUntil: 0, scanned: false, failures: 0 };
      this.states.set(destination.id, state);
    }
    return state;
  }

  /** The idle cadence, never faster than the active one. */
  idleInterval(destination) {
    return Math.max(destination.idlePollMs ?? destination.pollMs, destination.pollMs);
  }

  /** The cadence this destination should currently run at. */
  intervalFor(destination) {
    const state = this.state(destination);

    // A destination that keeps failing is not going to activate anything, and
    // hammering it at block-time cadence just burns quota against an endpoint that is
    // down or misconfigured. Tolerate a couple of blips at full speed — those are
    // routine — then back off until it recovers.
    if (state.failures >= MAX_FAST_FAILURES) return this.idleInterval(destination);

    const active = !state.scanned || state.pending > 0 || this.now() < state.activeUntil;
    return active ? destination.pollMs : this.idleInterval(destination);
  }

  /**
   * A relay was accepted — a note is inbound. Wakes every destination, because the
   * app server forwards relay bodies verbatim and deliberately does not parse them to
   * learn the destination. Nudging all of them costs one active window; teaching this
   * process the relayer's request schema would cost a coupling that has to be kept in
   * sync forever.
   */
  nudge() {
    const at = this.now();
    for (const destination of this.getDestinations()) {
      const state = this.state(destination);
      state.activeUntil = Math.max(state.activeUntil, at + (destination.activeWindowMs ?? 0));
      // Re-arm now: the destination may be parked on a long idle timer, and waiting
      // it out would waste most of the window we just opened.
      if (this.timers.has(destination.id)) this.schedule(destination, 0);
    }
  }

  start() {
    const destinations = this.getDestinations();
    if (destinations.length === 0) {
      this.logger.log("[l2-auto-activate] no destinations configured; scanner not started");
      return;
    }
    for (const destination of destinations) {
      if (this.timers.has(destination.id)) continue;
      this.logger.log(
        `[l2-auto-activate] scanning ${destination.label}: ${destination.pollMs}ms active, ` +
          `${this.idleInterval(destination)}ms idle`,
      );
      this.timers.set(destination.id, null);
      this.schedule(destination, 0);
    }
  }

  stop() {
    for (const timer of this.timers.values()) if (timer) this.clearTimer(timer);
    this.timers.clear();
  }

  /** Self-rescheduling, because the interval changes as the destination goes quiet. */
  schedule(destination, delay) {
    const existing = this.timers.get(destination.id);
    if (existing) this.clearTimer(existing);

    const timer = this.setTimer(() => {
      void this.tick(destination).finally(() => {
        // Only reschedule if we were not stopped while the tick was running.
        if (this.timers.has(destination.id)) this.schedule(destination, this.intervalFor(destination));
      });
    }, delay);
    timer?.unref?.();
    this.timers.set(destination.id, timer);
  }

  /** Overlap protection per destination: a slow scan must not stack behind its timer. */
  tick(destination) {
    const running = this.inFlight.get(destination.id);
    if (running) return running;

    const run = this.runTick(destination).finally(() => this.inFlight.delete(destination.id));
    this.inFlight.set(destination.id, run);
    return run;
  }

  async runTick(destination) {
    const state = this.state(destination);
    try {
      const scanned = await this.scan(destination);
      state.pending = countPending(scanned);
      state.scanned = true;
      state.failures = 0;

      for (const note of planBackedActivations(scanned)) {
        try {
          const result = await this.activate(destination, note);
          this.logger.log(
            `[l2-auto-activate] ${destination.label} activated ${note.commitment} (${result?.txHash ?? "no hash"})`,
          );
        } catch (error) {
          // One rejected note must not abandon the rest of the batch. The relayer
          // refuses anything it finds unbacked, which is expected while a bridge
          // transfer is still settling — it will be retried on the next tick.
          this.logger.warn(
            `[l2-auto-activate] ${destination.label} could not activate ${note.commitment}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
    } catch (error) {
      // Scanning failed (RPC down, pool unreachable). Retried next tick. `pending` is
      // deliberately left as it was: a failed scan is not evidence of an empty pool,
      // and zeroing it here would drop the destination to idle exactly when it is
      // least able to afford the extra latency. Repeated failures do back it off —
      // see `intervalFor` — so a permanently broken destination cannot poll forever.
      state.failures += 1;
      this.logger.warn(
        `[l2-auto-activate] ${destination.label} scan failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}
