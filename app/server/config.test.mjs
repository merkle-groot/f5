import assert from "node:assert/strict";
import test from "node:test";
import { getEvmL2s, logChunkBlocks } from "./config.mjs";

/** Config is read from `process.env` on every call, so each test states its own world. */
function withEnv(vars, fn) {
  const saved = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("a per-chain log chunk overrides the global, which overrides the default", () => {
  withEnv({ LOG_CHUNK_BLOCKS: undefined, ARB_LOG_CHUNK_BLOCKS: undefined }, () => {
    assert.equal(logChunkBlocks("ARB"), 9000n);
    assert.equal(logChunkBlocks(), 9000n);
  });

  withEnv({ LOG_CHUNK_BLOCKS: "100000", ARB_LOG_CHUNK_BLOCKS: undefined }, () => {
    assert.equal(logChunkBlocks("ARB"), 100000n);
    assert.equal(logChunkBlocks(), 100000n);
  });

  withEnv({ LOG_CHUNK_BLOCKS: "100000", ARB_LOG_CHUNK_BLOCKS: "500000" }, () => {
    assert.equal(logChunkBlocks("ARB"), 500000n);
    // The global is what every other chain still gets.
    assert.equal(logChunkBlocks("BASE"), 100000n);
  });
});

test("a garbage or non-positive chunk falls back instead of stalling fetchRange", () => {
  for (const bad of ["", "0", "-1", "9000 blocks", "1e5", "abc"]) {
    withEnv({ LOG_CHUNK_BLOCKS: undefined, ARB_LOG_CHUNK_BLOCKS: bad }, () => {
      assert.equal(logChunkBlocks("ARB"), 9000n, `expected fallback for ${JSON.stringify(bad)}`);
    });
  }

  // A bad per-chain value falls through to the global rather than all the way to 9000.
  withEnv({ LOG_CHUNK_BLOCKS: "100000", ARB_LOG_CHUNK_BLOCKS: "nope" }, () => {
    assert.equal(logChunkBlocks("ARB"), 100000n);
  });
});

test("each configured EVM destination carries its own chunk width", () => {
  withEnv({
    L2_EVM_CHAINS: "op,arb",
    LOG_CHUNK_BLOCKS: "100000",
    ARB_LOG_CHUNK_BLOCKS: "500000",
    OP_CHAIN_ID: "11155420",
    OP_RPC_URL: "https://op.invalid",
    OP_POOL_ADDRESS: "0x0000000000000000000000000000000000000001",
    ARB_CHAIN_ID: "421614",
    ARB_RPC_URL: "https://arb.invalid",
    ARB_POOL_ADDRESS: "0x0000000000000000000000000000000000000002",
  }, () => {
    const byKey = Object.fromEntries(getEvmL2s().map((chain) => [chain.key, chain.logChunkBlocks]));
    assert.deepEqual(byKey, { op: 100000n, arb: 500000n });
  });
});
