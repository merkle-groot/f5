import assert from "node:assert/strict";
import test from "node:test";
import { STARKNET_STATUS_RETRIES, starknetRetryDelayMs, starknetStatusUnsettled } from "./starknet-status.js";

test("a healthy destination is settled", () => {
  assert.equal(
    starknetStatusUnsettled({ configured: true, relayerReady: true, l1PoolMatches: true }),
    false,
  );
});

/**
 * The reported bug: the app server answered before the relayer had bound its port, and
 * the resulting `relayerReady: false` was latched on screen until the page reloaded.
 */
test("a relayer that has not reported its keys yet is worth asking again", () => {
  assert.equal(starknetStatusUnsettled({ configured: false, relayerReady: false }), true);
  assert.equal(starknetStatusUnsettled({ configured: false, unavailable: true }), true);
  assert.equal(starknetStatusUnsettled(undefined), true);
  assert.equal(starknetStatusUnsettled(null), true);
  assert.equal(starknetStatusUnsettled("nope"), true);
});

/**
 * A pool bound to a different L1 pool cannot be fixed by asking again — `l1_pool` is
 * immutable in the Cairo constructor. Retrying would poll forever AND the destination
 * has to stay disabled either way, so this must read as settled.
 */
test("a mismatched l1_pool binding is permanent, even with the relayer down", () => {
  assert.equal(starknetStatusUnsettled({ configured: false, l1PoolMatches: false }), false);
  assert.equal(
    starknetStatusUnsettled({ configured: false, l1PoolMatches: false, relayerReady: false }),
    false,
  );
  // ...but an unreachable API is still unknown: we have not confirmed the mismatch.
  assert.equal(
    starknetStatusUnsettled({ configured: false, l1PoolMatches: false, unavailable: true }),
    true,
  );
});

test("backoff doubles to a ceiling and covers a boot race across the retry budget", () => {
  const delays = Array.from({ length: STARKNET_STATUS_RETRIES }, (_, i) => starknetRetryDelayMs(i));
  assert.deepEqual(delays, [500, 1000, 2000, 4000, 5000]);
  assert.equal(starknetRetryDelayMs(99), 5000);
  assert.equal(delays.reduce((a, b) => a + b, 0), 12500);
});
