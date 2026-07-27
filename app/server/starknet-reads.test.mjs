import assert from "node:assert/strict";
import test from "node:test";
import { getNoteLifecycleEvents } from "./starknet-reads.mjs";

test("reads and partitions all three Starknet note lifecycle events in one request", async () => {
  const requests = [];
  const provider = {
    getBlockNumber: async () => 20,
    getEvents: async (request) => {
      requests.push(request);
      const [receivedSelector, activatedSelector, withdrawnSelector] = request.keys[0];
      return {
        events: [
          {
            block_number: 11,
            keys: [receivedSelector, "0x1", "0x0"],
            data: ["0x2", "0x0"],
          },
          {
            block_number: 12,
            keys: [activatedSelector, "0x3", "0x0"],
            data: ["0x4", "0x0"],
          },
          {
            // Withdrawn keys only `recipient`, so the nullifier hash is the first
            // u256 in `data` — a different layout from the other two events.
            block_number: 13,
            keys: [withdrawnSelector, "0xrecipient"],
            data: ["0x5", "0x0", "0x6", "0x0", "0x0", "0x0"],
          },
        ],
        continuation_token: undefined,
      };
    },
  };

  const lifecycle = await getNoteLifecycleEvents(provider, {
    rpcUrl: "https://combined-lifecycle.invalid",
    poolAddress: "0x123",
    deploymentBlock: 10,
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].keys[0].length, 3);
  assert.deepEqual(lifecycle, {
    received: [{ commitment: 1n, value: 2n }],
    activated: [{ commitment: 3n, value: 4n }],
    spent: [{ spentNullifier: 5n, value: 6n }],
  });
});
