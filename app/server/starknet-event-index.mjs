function compareEvents(a, b) {
  const block = Number(a.block_number ?? 0) - Number(b.block_number ?? 0);
  return block;
}
/** Incremental, paginated Starknet event index with head and in-flight coalescing. */
export class StarknetEventIndex {
  constructor({
    retry = (fn) => fn(),
    reorgBuffer = 16,
    chunkSize = Number(process.env.STARKNET_EVENT_CHUNK_SIZE ?? 100),
    headTtlMs = Number(process.env.RPC_HEAD_TTL_MS ?? 2500),
    now = () => Date.now(),
  } = {}) {
    this.retry = retry;
    this.reorgBuffer = reorgBuffer;
    this.chunkSize = chunkSize;
    this.headTtlMs = headTtlMs;
    this.now = now;
    this.heads = new Map();
    this.streams = new Map();
  }

  async head(rpcUrl, provider) {
    let state = this.heads.get(rpcUrl);
    if (!state) {
      state = { value: null, fetchedAt: 0, inFlight: null };
      this.heads.set(rpcUrl, state);
    }
    if (state.value !== null && this.now() - state.fetchedAt < this.headTtlMs) return state.value;
    if (state.inFlight) return state.inFlight;
    state.inFlight = this.retry(() => provider.getBlockNumber())
      .then((head) => {
        state.value = Number(head);
        state.fetchedAt = this.now();
        return state.value;
      })
      .finally(() => { state.inFlight = null; });
    return state.inFlight;
  }

  streamId({ rpcUrl, address, eventName, eventNames }) {
    const key = eventNames?.join("|") ?? eventName;
    return `${rpcUrl}\u0000${address.toLowerCase()}:${key}`;
  }

  async read(params) {
    const id = this.streamId(params);
    let state = this.streams.get(id);
    if (!state) {
      state = { events: [], cursor: null, lastHead: null, inFlight: null };
      this.streams.set(id, state);
    }
    if (state.inFlight) return state.inFlight;
    state.inFlight = this.refresh(state, params).finally(() => { state.inFlight = null; });
    return state.inFlight;
  }

  async refresh(state, { rpcUrl, provider, address, eventName, eventNames, selector, selectors, fromBlock }) {
    const head = await this.head(rpcUrl, provider);
    if (state.lastHead === head) return state.events;

    const floor = Number(fromBlock);
    const start = state.cursor === null ? floor : Math.max(floor, state.cursor);
    const retained = state.events.filter((event) => Number(event.block_number ?? 0) < start);
    const fresh = [];
    let token;
    if (start <= head) {
      do {
        const page = await this.retry(() => provider.getEvents({
          address,
          keys: [selectors ?? [selector]],
          from_block: { block_number: start },
          to_block: { block_number: head },
          chunk_size: this.chunkSize,
          ...(token ? { continuation_token: token } : {}),
        }));
        if (!page) {
          const label = eventNames?.join("/") ?? eventName;
          throw new Error(`Starknet RPC returned no result for ${label} on ${address}`);
        }
        fresh.push(...(page.events ?? []));
        token = page.continuation_token;
      } while (token);
    }

    state.events = [...retained, ...fresh].sort(compareEvents);
    state.cursor = Math.max(floor, head - this.reorgBuffer);
    state.lastHead = head;
    return state.events;
  }
}
