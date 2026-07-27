import assert from "node:assert/strict";
import test from "node:test";
import { eventIndex, readEvmL2NoteEvents, readL1SpendEvents } from "./evm-reads.mjs";

test("reads and partitions all three EVM note lifecycle events from one index stream", async () => {
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
      {
        eventName: "Withdrawn",
        args: { _recipient: "0x00000000000000000000000000000000000000ff", _spentNullifier: 5n, _value: 6n, _feeAmount: 1n },
        blockNumber: 13n,
        transactionHash: "0xccc",
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

    assert.deepEqual(request.events.map((event) => event.name), ["NoteReceived", "NoteActivated", "Withdrawn"]);
    assert.equal(request.event, undefined);
    assert.deepEqual(lifecycle, {
      received: [{ commitment: 1n, value: 2n, blockNumber: 11n, transactionHash: "0xaaa" }],
      activated: [{ commitment: 3n, value: 4n, blockNumber: 12n, transactionHash: "0xbbb" }],
      spent: [{ spentNullifier: 5n, value: 6n, blockNumber: 13n, transactionHash: "0xccc" }],
    });
  } finally {
    eventIndex.read = originalRead;
  }
});

test("indexes every L1 pool event through one shared log request and partitions spends", async () => {
  const originalRead = eventIndex.read;
  let request;
  eventIndex.read = async (params) => {
    request = params;
    return [
      { eventName: "Withdrawn", args: { _spentNullifier: 11n } },
      { eventName: "Ragequit", args: { _commitment: 22n } },
    ];
  };

  try {
    const spent = await readL1SpendEvents();
    assert.deepEqual(request.events.map((event) => event.name), [
      "Deposited",
      "LeafInserted",
      "Withdrawn",
      "Ragequit",
      "L2Note",
    ]);
    assert.equal(request.event, undefined);
    assert.equal(spent.withdrawals[0].args._spentNullifier, 11n);
    assert.equal(spent.ragequits[0].args._commitment, 22n);
  } finally {
    eventIndex.read = originalRead;
  }
});
