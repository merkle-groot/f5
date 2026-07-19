import assert from "node:assert/strict";
import { it } from "node:test";
import { activationDestinations } from "./destinations.mjs";

it("uses the shared 15-second active scan interval for every destination", () => {
  const keys = [
    "L2_AUTO_ACTIVATE",
    "L2_SCAN_POLL_MS",
    "L2_EVM_CHAINS",
    "OP_RPC_URL",
    "OP_POOL_ADDRESS",
    "BASE_RPC_URL",
    "BASE_POOL_ADDRESS",
    "STARKNET_RPC_URL",
    "STARKNET_POOL_ADDRESS",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));

  Object.assign(process.env, {
    L2_AUTO_ACTIVATE: "true",
    L2_SCAN_POLL_MS: "15000",
    L2_EVM_CHAINS: "op,base",
    OP_RPC_URL: "http://op.example",
    OP_POOL_ADDRESS: "0x0000000000000000000000000000000000000001",
    BASE_RPC_URL: "http://base.example",
    BASE_POOL_ADDRESS: "0x0000000000000000000000000000000000000002",
    STARKNET_RPC_URL: "http://starknet.example",
    STARKNET_POOL_ADDRESS: "0x3",
  });

  try {
    const destinations = activationDestinations();
    assert.deepEqual(destinations.map(({ key, pollMs }) => [key, pollMs]), [
      ["op", 15_000],
      ["base", 15_000],
      ["starknet", 15_000],
    ]);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
