/**
 * Process-wide snapshot of every L1 note that has been spent.
 *
 * The browser only reads this snapshot; it never causes an RPC request. One
 * background refresh serves every user and shares EventIndex's incremental cursor,
 * reorg window, concurrency limiter, and coalescing.
 */
import { readL1SpendEvents } from "./evm-reads.mjs";
import { l1SpendScanMs } from "./config.mjs";

export class L1SpendSnapshot {
  constructor({
    read,
    intervalMs = 60_000,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    logger = console,
  }) {
    this.read = read;
    this.intervalMs = Math.max(5_000, Number.isFinite(intervalMs) ? intervalMs : 60_000);
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.logger = logger;
    this.value = null;
    this.error = null;
    this.inFlight = null;
    this.timer = null;
  }

  snapshot() {
    return this.value;
  }

  isFresh(maxAgeMs = this.intervalMs * 2) {
    return Boolean(this.value && this.now() - this.value.updatedAt <= maxAgeMs);
  }

  refresh() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async runRefresh() {
    try {
      const { withdrawals, ragequits } = await this.read();
      this.value = {
        nullifiers: [...new Set(withdrawals.map((log) => String(log.args._spentNullifier)))],
        ragequitCommitments: [...new Set(ragequits.map((log) => String(log.args._commitment)))],
        updatedAt: this.now(),
      };
      this.error = null;
      return this.value;
    } catch (error) {
      this.error = error;
      this.logger.warn("[l1-spend-scan] refresh failed:", error);
      return this.value;
    }
  }

  start() {
    if (this.timer) return;
    const tick = async () => {
      await this.refresh();
      if (!this.timer) return;
      this.timer = this.setTimer(tick, this.intervalMs);
      this.timer?.unref?.();
    };
    this.timer = this.setTimer(tick, 0);
    this.timer?.unref?.();
  }

  stop() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }
}

export const l1SpendSnapshot = new L1SpendSnapshot({
  read: readL1SpendEvents,
  intervalMs: l1SpendScanMs(),
});
