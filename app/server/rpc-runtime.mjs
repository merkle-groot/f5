import { createPublicClient, http } from "viem";

function isRateLimitError(error) {
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (current.status === 429 || current.statusCode === 429) return true;
    const message = [current.message, current.shortMessage, current.details].filter(Boolean).join(" ");
    if (/\b429\b|rate[ -]?limit|too many requests/i.test(message)) return true;
    current = current.cause;
  }
  return false;
}

/** In-process counters. RPC URLs and request parameters are deliberately never retained. */
export class RpcMetrics {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.startedAt = now();
    this.methods = new Map();
    this.cache = {
      headHits: 0,
      headMisses: 0,
      headCoalesced: 0,
      eventHits: 0,
      eventMisses: 0,
      eventCoalesced: 0,
      readHits: 0,
      readMisses: 0,
      readCoalesced: 0,
    };
  }

  observe(chain, method, elapsedMs, error) {
    const id = `${chain}:${method}`;
    const entry = this.methods.get(id) ?? {
      chain,
      method,
      calls: 0,
      errors: 0,
      rateLimited: 0,
      totalMs: 0,
      maxMs: 0,
    };
    entry.calls += 1;
    entry.totalMs += elapsedMs;
    entry.maxMs = Math.max(entry.maxMs, elapsedMs);
    if (error) {
      entry.errors += 1;
      if (isRateLimitError(error)) entry.rateLimited += 1;
    }
    this.methods.set(id, entry);
  }

  snapshot() {
    const methods = [...this.methods.values()]
      .map((entry) => ({
        ...entry,
        averageMs: entry.calls ? Number((entry.totalMs / entry.calls).toFixed(2)) : 0,
        totalMs: Number(entry.totalMs.toFixed(2)),
        maxMs: Number(entry.maxMs.toFixed(2)),
      }))
      .sort((a, b) => b.calls - a.calls || a.chain.localeCompare(b.chain) || a.method.localeCompare(b.method));
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      generatedAt: new Date(this.now()).toISOString(),
      totals: methods.reduce(
        (out, entry) => ({
          calls: out.calls + entry.calls,
          errors: out.errors + entry.errors,
          rateLimited: out.rateLimited + entry.rateLimited,
        }),
        { calls: 0, errors: 0, rateLimited: 0 },
      ),
      cache: { ...this.cache },
      methods,
    };
  }
}

/** Wrap a viem transport and measure logical JSON-RPC calls without recording params. */
export function measuredTransport(baseTransport, chain, metrics, { clock = () => performance.now() } = {}) {
  return (options) => {
    const transport = baseTransport(options);
    return {
      ...transport,
      async request(args) {
        const started = clock();
        try {
          const result = await transport.request(args);
          metrics.observe(chain, args.method, clock() - started);
          return result;
        } catch (error) {
          metrics.observe(chain, args.method, clock() - started, error);
          throw error;
        }
      },
    };
  };
}

/**
 * Owns one public client per logical chain/RPC URL and coalesces head reads.
 * Keeping the URL in the internal key prevents an environment reload from reusing
 * a client pointed at the old provider; metrics expose only the logical chain key.
 */
export class RpcRuntime {
  constructor({
    clientFactory,
    headTtlMs = Number(process.env.RPC_HEAD_TTL_MS ?? 2500),
    metrics = new RpcMetrics(),
    now = () => Date.now(),
  } = {}) {
    this.metrics = metrics;
    this.now = now;
    this.headTtlMs = headTtlMs;
    this.clients = new Map();
    this.heads = new Map();
    this.reads = new Map();
    this.clientFactory = clientFactory ?? ((rpcUrl, chain) => createPublicClient({
      transport: measuredTransport(http(rpcUrl), chain, this.metrics),
    }));
  }

  cacheKey(chain, rpcUrl) {
    return `${chain}\u0000${rpcUrl}`;
  }

  client(chain, rpcUrl) {
    if (!rpcUrl) throw new Error(`Missing RPC URL for ${chain}`);
    const id = this.cacheKey(chain, rpcUrl);
    let client = this.clients.get(id);
    if (!client) {
      client = this.clientFactory(rpcUrl, chain);
      this.clients.set(id, client);
    }
    return client;
  }

  async head(chain, rpcUrl, { force = false, maxAgeMs = this.headTtlMs } = {}) {
    const id = this.cacheKey(chain, rpcUrl);
    let state = this.heads.get(id);
    if (!state) {
      state = { value: null, fetchedAt: 0, inFlight: null };
      this.heads.set(id, state);
    }

    if (!force && state.value !== null && this.now() - state.fetchedAt < maxAgeMs) {
      this.metrics.cache.headHits += 1;
      return state.value;
    }
    if (state.inFlight) {
      this.metrics.cache.headCoalesced += 1;
      return state.inFlight;
    }

    this.metrics.cache.headMisses += 1;
    state.inFlight = this.client(chain, rpcUrl).getBlockNumber()
      .then((head) => {
        state.value = head;
        state.fetchedAt = this.now();
        return head;
      })
      .finally(() => {
        state.inFlight = null;
      });
    return state.inFlight;
  }

  async cachedRead(key, loader, { force = false, maxAgeMs = Number.POSITIVE_INFINITY } = {}) {
    let state = this.reads.get(key);
    if (!state) {
      state = { value: undefined, hasValue: false, fetchedAt: 0, inFlight: null };
      this.reads.set(key, state);
    }
    if (!force && state.hasValue && this.now() - state.fetchedAt < maxAgeMs) {
      this.metrics.cache.readHits += 1;
      return state.value;
    }
    if (state.inFlight) {
      this.metrics.cache.readCoalesced += 1;
      return state.inFlight;
    }
    this.metrics.cache.readMisses += 1;
    state.inFlight = Promise.resolve()
      .then(loader)
      .then((value) => {
        state.value = value;
        state.hasValue = true;
        state.fetchedAt = this.now();
        return value;
      })
      .finally(() => {
        state.inFlight = null;
      });
    return state.inFlight;
  }

  snapshot() {
    return this.metrics.snapshot();
  }
}

export const rpcRuntime = new RpcRuntime();
