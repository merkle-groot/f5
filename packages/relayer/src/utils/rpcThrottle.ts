/**
 * Limit concurrent work independently per key.
 *
 * Ported from the app server's `event-index.mjs`, where it capped `eth_getLogs`
 * concurrency per chain. The relayer's own fan-out is much smaller now that it does
 * not poll — one batched read per activation request — but requests still arrive in
 * bursts, and a burst of concurrent activations is exactly what trips a per-minute
 * quota on the endpoint they all share.
 *
 * `RPC_CONCURRENCY` is shared with the app server's limiter
 * (`app/server/event-index.mjs`) on purpose: both processes hit the same endpoints,
 * so a per-endpoint budget only means something if one value tunes both. Keep the
 * name in sync if it ever changes.
 */
export class KeyedConcurrencyLimiter {
  private readonly limit: number;
  private readonly states = new Map<string, { active: number; waiting: (() => void)[] }>();

  constructor(limit = Number(process.env.RPC_CONCURRENCY ?? 1)) {
    this.limit = Math.max(1, Number.isFinite(limit) ? limit : 1);
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let state = this.states.get(key);
    if (!state) {
      state = { active: 0, waiting: [] };
      this.states.set(key, state);
    }

    if (state.active >= this.limit) {
      await new Promise<void>((resolve) => state!.waiting.push(resolve));
    } else {
      state.active += 1;
    }

    try {
      return await fn();
    } finally {
      const next = state.waiting.shift();
      if (next) {
        // Hand this slot straight to the waiter. Leaving `active` untouched closes the
        // microtask gap in which a third caller could otherwise slip in over the limit.
        next();
      } else {
        state.active -= 1;
        if (state.active === 0) this.states.delete(key);
      }
    }
  }
}

/**
 * Per-endpoint RPC throttling shared by every destination provider.
 *
 * Keyed by RPC URL rather than chain id, because the quota that actually gets tripped
 * belongs to the endpoint (the provider API key), not the chain. Two destinations
 * configured against the same node therefore share one budget, which is the point.
 *
 * There is no head-caching here any more: that existed to stop each event stream
 * fetching its own `getBlockNumber` every tick, and the relayer no longer has event
 * streams or ticks. The app server still needs it and still has it (`RpcRuntime`).
 */
export class RpcThrottle {
  private readonly limiter: KeyedConcurrencyLimiter;

  constructor(limiter = new KeyedConcurrencyLimiter()) {
    this.limiter = limiter;
  }

  /** Run one RPC call, waiting for a free slot on that endpoint. */
  call<T>(rpcUrl: string, fn: () => Promise<T>): Promise<T> {
    return this.limiter.run(rpcUrl, fn);
  }
}

/** One throttle for the whole process, so every provider shares the same budget. */
export const rpcThrottle = new RpcThrottle();
