import assert from "node:assert/strict";
import test from "node:test";
import { EventIndex, KeyedConcurrencyLimiter } from "./event-index.mjs";

function makeRuntime({ head = 15n, dataset = [] } = {}) {
  const calls = [];
  const metrics = { cache: { eventHits: 0, eventMisses: 0, eventCoalesced: 0 } };
  const client = {
    async getLogs({ fromBlock, toBlock }) {
      calls.push([fromBlock, toBlock]);
      return dataset.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock);
    },
  };
  return {
    metrics,
    calls,
    client: () => client,
    head: async () => head,
    setHead: (value) => { head = value; },
    setDataset: (value) => { dataset = value; },
  };
}

const params = {
  chain: "evm:1",
  rpcUrl: "https://rpc.invalid",
  address: "0x0000000000000000000000000000000000000001",
  eventKey: "Deposited",
  event: { type: "event", name: "Deposited", inputs: [] },
  fromBlock: 10n,
};

test("indexes in chunks and performs no log call when the head is unchanged", async () => {
  const runtime = makeRuntime({ dataset: [
    { blockNumber: 11n, transactionHash: "0xa", logIndex: 0 },
    { blockNumber: 15n, transactionHash: "0xb", logIndex: 0 },
  ] });
  const index = new EventIndex({ runtime, chunkBlocks: 2n, reorgBuffer: 2n });
  assert.equal((await index.read(params)).length, 2);
  assert.deepEqual(runtime.calls, [[10n, 12n], [13n, 15n]]);
  assert.equal((await index.read(params)).length, 2);
  assert.equal(runtime.calls.length, 2);
  assert.equal(runtime.metrics.cache.eventHits, 1);
});

test("rolls back and replaces logs in the reorg window", async () => {
  const runtime = makeRuntime({ dataset: [
    { blockNumber: 11n, transactionHash: "0xa", logIndex: 0 },
    { blockNumber: 14n, transactionHash: "0xold", logIndex: 0 },
  ] });
  const index = new EventIndex({ runtime, chunkBlocks: 10n, reorgBuffer: 2n });
  await index.read(params);

  runtime.setHead(16n);
  runtime.setDataset([
    { blockNumber: 11n, transactionHash: "0xa", logIndex: 0 },
    { blockNumber: 14n, transactionHash: "0xnew", logIndex: 0 },
    { blockNumber: 16n, transactionHash: "0xc", logIndex: 0 },
  ]);
  const logs = await index.read(params);
  assert.deepEqual(logs.map((log) => log.transactionHash), ["0xa", "0xnew", "0xc"]);
  assert.deepEqual(runtime.calls.at(-1), [13n, 16n]);
});

test("coalesces a burst of concurrent refreshes", async () => {
  let release;
  const runtime = makeRuntime();
  runtime.client = () => ({
    getLogs: async () => {
      await new Promise((resolve) => { release = resolve; });
      return [];
    },
  });
  const index = new EventIndex({ runtime, chunkBlocks: 10n });
  const first = index.read(params);
  await Promise.resolve();
  const burst = Array.from({ length: 19 }, () => index.read(params));
  await Promise.resolve();
  release();
  const expected = await first;
  for (const result of await Promise.all(burst)) assert.equal(result, expected);
  assert.equal(runtime.metrics.cache.eventCoalesced, 19);
});

test("serializes log requests from different streams on the same chain", async () => {
  let active = 0;
  let maxActive = 0;
  const runtime = makeRuntime();
  runtime.client = () => ({
    getLogs: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return [];
    },
  });
  const index = new EventIndex({
    runtime,
    chunkBlocks: 10n,
    limiter: new KeyedConcurrencyLimiter(1),
  });
  await Promise.all([
    index.read(params),
    index.read({ ...params, eventKey: "Withdrawn", event: { ...params.event, name: "Withdrawn" } }),
  ]);
  assert.equal(maxActive, 1);
});
