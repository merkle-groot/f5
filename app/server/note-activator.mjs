/**
 * Choose pending notes that can be activated without exceeding the pool's
 * remaining bridge backing. The contract repeats this check authoritatively;
 * doing it here avoids submitting transactions that are guaranteed to revert.
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
    if (value <= 0n || value > available) continue;
    planned.push({ ...event, commitment: BigInt(event.commitment), value });
    available -= value;
  }
  return planned;
}

/** Serialize signer work per chain/account while allowing unrelated destinations to proceed. */
export class KeyedSerialExecutor {
  constructor() {
    this.tails = new Map();
  }

  run(key, task) {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    this.tails.set(key, current);
    const cleanup = () => {
      if (this.tails.get(key) === current) this.tails.delete(key);
    };
    current.then(cleanup, cleanup);
    return current;
  }
}

/**
 * Small detached poller with overlap protection. Destination-specific chain
 * reads and transaction submission stay in index.mjs; this class only owns the
 * lifecycle and makes failures retryable on the next tick.
 */
export class AutomaticNoteActivator {
  constructor({ getDestinations, refresh, intervalMs = 10_000, logger = console }) {
    this.getDestinations = getDestinations;
    this.refresh = refresh;
    const configuredInterval = Number(intervalMs);
    this.intervalMs = Number.isFinite(configuredInterval) && configuredInterval > 0
      ? Math.max(1_000, configuredInterval)
      : 10_000;
    this.logger = logger;
    this.inFlight = null;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runTick().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async runTick() {
    const destinations = this.getDestinations();
    await Promise.all(destinations.map(async (destination) => {
      try {
        await this.refresh(destination);
      } catch (error) {
        this.logger.warn(
          `[l2-auto-activate] ${destination.label ?? destination.id} failed:`,
          error instanceof Error ? error.message : error,
        );
      }
    }));
  }
}
