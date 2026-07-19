import assert from "node:assert/strict";
import test from "node:test";
import { StarknetEventIndex } from "./starknet-event-index.mjs";

const params = {
  rpcUrl: "https://starknet.invalid",
  address: "0x123",
  eventName: "NoteReceived",
  selector: "0xabc",
  fromBlock: 10,
};

test("paginates once, caches an unchanged head, and resumes from the reorg window", async () => {
  let now = 0;
  let head = 15;
  let events = [
    { block_number: 11, transaction_hash: "0xa" },
    { block_number: 14, transaction_hash: "0xold" },
  ];
  const ranges = [];
  let headCalls = 0;
  const provider = {
    getBlockNumber: async () => { headCalls += 1; return head; },
    getEvents: async ({ from_block, to_block }) => {
      ranges.push([from_block.block_number, to_block.block_number]);
      return {
        events: events.filter((event) => event.block_number >= from_block.block_number && event.block_number <= to_block.block_number),
        continuation_token: undefined,
      };
    },
  };
  const index = new StarknetEventIndex({ now: () => now, headTtlMs: 10, reorgBuffer: 2 });
  assert.equal((await index.read({ ...params, provider })).length, 2);
  assert.equal((await index.read({ ...params, provider })).length, 2);
  assert.equal(ranges.length, 1);
  assert.equal(headCalls, 1);

  now = 11;
  head = 16;
  events = [
    { block_number: 11, transaction_hash: "0xa" },
    { block_number: 14, transaction_hash: "0xnew" },
    { block_number: 16, transaction_hash: "0xc" },
  ];
  const refreshed = await index.read({ ...params, provider });
  assert.deepEqual(refreshed.map((event) => event.transaction_hash), ["0xa", "0xnew", "0xc"]);
  assert.deepEqual(ranges.at(-1), [13, 16]);
});

test("coalesces concurrent stream refreshes", async () => {
  let release;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  let calls = 0;
  const provider = {
    getBlockNumber: async () => 12,
    getEvents: async () => {
      calls += 1;
      markStarted();
      await new Promise((resolve) => { release = resolve; });
      return { events: [], continuation_token: undefined };
    },
  };
  const index = new StarknetEventIndex();
  const first = index.read({ ...params, provider });
  await started;
  const second = index.read({ ...params, provider });
  release();
  assert.equal(await first, await second);
  assert.equal(calls, 1);
});

test("passes multiple selectors through one cached event stream", async () => {
  const requests = [];
  const provider = {
    getBlockNumber: async () => 12,
    getEvents: async (request) => {
      requests.push(request);
      return { events: [], continuation_token: undefined };
    },
  };
  const index = new StarknetEventIndex();
  const selectors = ["0xabc", "0xdef"];

  await index.read({
    ...params,
    provider,
    eventName: undefined,
    selector: undefined,
    eventNames: ["NoteReceived", "NoteActivated"],
    selectors,
  });

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].keys, [selectors]);
});
