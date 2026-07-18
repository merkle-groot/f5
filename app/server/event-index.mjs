function logId(log) {
  return `${log.transactionHash ?? ""}:${log.logIndex ?? ""}`;
}

function compareLogs(a, b) {
  const block = (a.blockNumber ?? 0n) - (b.blockNumber ?? 0n);
  if (block !== 0n) return block < 0n ? -1 : 1;
  return Number((a.logIndex ?? 0) - (b.logIndex ?? 0));
}

/** Limit concurrent expensive work independently for each chain. */
export class KeyedConcurrencyLimiter {
  constructor(limit = Number(process.env.RPC_LOG_CONCURRENCY ?? 1)) {
    this.limit = Math.max(1, Number(limit));
    this.states = new Map();
  }

  async run(key, fn) {
    let state = this.states.get(key);
    if (!state) {
      state = { active: 0, waiting: [] };
      this.states.set(key, state);
    }
    if (state.active >= this.limit) {
      await new Promise((resolve) => state.waiting.push(resolve));
    } else {
      state.active += 1;
    }
    try {
      return await fn();
    } finally {
      const next = state.waiting.shift();
      if (next) {
        // Transfer this slot directly to the waiter. Keeping `active` unchanged
        // closes the microtask gap in which a third caller could otherwise enter.
        next();
      } else {
        state.active -= 1;
        if (state.active === 0) this.states.delete(key);
      }
    }
  }
}

/**
 * Shared, incremental raw-log index.
 *
 * Each event stream is keyed independently, but all streams share RpcRuntime's
 * clients and head snapshots. Refresh rolls back the trailing reorg window before
 * refetching it; merely deduplicating is insufficient because a reorg can remove a
 * previously cached log altogether.
 */
export class EventIndex {
  constructor({
    runtime,
    chunkBlocks = BigInt(process.env.LOG_CHUNK_BLOCKS ?? "9000"),
    reorgBuffer = 16n,
    retry = (fn) => fn(),
    limiter = new KeyedConcurrencyLimiter(),
  }) {
    this.runtime = runtime;
    this.chunkBlocks = BigInt(chunkBlocks);
    this.reorgBuffer = BigInt(reorgBuffer);
    this.retry = retry;
    this.limiter = limiter;
    this.streams = new Map();
  }

  streamId({ chain, rpcUrl, address, eventKey }) {
    return `${chain}\u0000${rpcUrl}\u0000${address.toLowerCase()}:${eventKey}`;
  }

  state(params) {
    const id = this.streamId(params);
    let state = this.streams.get(id);
    if (!state) {
      state = { logs: [], cursor: null, lastHead: null, inFlight: null };
      this.streams.set(id, state);
    }
    return state;
  }

  async read(params) {
    const state = this.state(params);
    if (params.force && state.inFlight) {
      try { await state.inFlight; } catch { /* the forced replay below is authoritative */ }
    } else if (state.inFlight) {
      this.runtime.metrics.cache.eventCoalesced += 1;
      return state.inFlight;
    }

    if (params.force) {
      state.logs = [];
      state.cursor = null;
      state.lastHead = null;
    }

    state.inFlight = this.refresh(state, params).finally(() => {
      state.inFlight = null;
    });
    return state.inFlight;
  }

  async refresh(state, { chain, rpcUrl, address, event, fromBlock, force = false }) {
    const head = await this.runtime.head(chain, rpcUrl, { force });
    if (!force && state.lastHead === head) {
      this.runtime.metrics.cache.eventHits += 1;
      return state.logs;
    }

    this.runtime.metrics.cache.eventMisses += 1;
    const floor = BigInt(fromBlock);
    const start = state.cursor === null ? floor : state.cursor > floor ? state.cursor : floor;

    // Drop the overlap before refetching. This handles both replacement and
    // removal of logs when a shallow reorg changes blocks in the trailing window.
    const retained = state.logs.filter((log) => log.blockNumber < start);
    const fresh = start <= head
      ? await this.fetchRange({ chain, rpcUrl, address, event, fromBlock: start, toBlock: head })
      : [];
    const seen = new Set(retained.map(logId));
    for (const log of fresh) {
      const id = logId(log);
      if (seen.has(id)) continue;
      seen.add(id);
      retained.push(log);
    }
    retained.sort(compareLogs);

    const trailing = head > this.reorgBuffer ? head - this.reorgBuffer : 0n;
    state.logs = retained;
    state.cursor = trailing > floor ? trailing : floor;
    state.lastHead = head;
    return state.logs;
  }

  async fetchRange({ chain, rpcUrl, address, event, fromBlock, toBlock }) {
    const client = this.runtime.client(chain, rpcUrl);
    const logs = [];
    for (let start = fromBlock; start <= toBlock; start += this.chunkBlocks + 1n) {
      const end = start + this.chunkBlocks > toBlock ? toBlock : start + this.chunkBlocks;
      logs.push(...await this.limiter.run(
        chain,
        () => this.retry(() => client.getLogs({ address, event, fromBlock: start, toBlock: end })),
      ));
    }
    return logs;
  }
}
