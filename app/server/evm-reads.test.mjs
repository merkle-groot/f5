import assert from "node:assert/strict";
import test from "node:test";
import { eventIndex, readEvmL2NoteEvents } from "./evm-reads.mjs";

test("reads and partitions both EVM note lifecycle events from one index stream", async () => {
  const originalRead = eventIndex.read;
  let request;
  eventIndex.read = async (params) => {
    request = params;
    return [
      {
        eventName: "NoteReceived",
        args: { _commitment: 1n, _value: 2n },
        blockNumber: 11n,
        transactionHash: "0xaaa",
      },
      {
        eventName: "NoteActivated",
        args: { _commitment: 3n, _value: 4n },
        blockNumber: 12n,
        transactionHash: "0xbbb",
      },
    ];
  };

  try {
    const lifecycle = await readEvmL2NoteEvents({
      chainId: 10,
      rpcUrl: "https://combined-lifecycle.invalid",
      poolAddress: "0x0000000000000000000000000000000000000001",
      deploymentBlock: 10,
    });

    assert.deepEqual(request.events.map((event) => event.name), ["NoteReceived", "NoteActivated"]);
    assert.equal(request.event, undefined);
    assert.deepEqual(lifecycle, {
      received: [{ commitment: 1n, value: 2n, blockNumber: 11n, transactionHash: "0xaaa" }],
      activated: [{ commitment: 3n, value: 4n, blockNumber: 12n, transactionHash: "0xbbb" }],
    });
  } finally {
    eventIndex.read = originalRead;
  }
});
