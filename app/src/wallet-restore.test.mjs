import assert from "node:assert/strict";
import test from "node:test";
import { mock } from "@wagmi/core";
import { createWallet } from "./wallet.js";

/**
 * Exactly one restore, in its own file.
 *
 * `reconnect` in @wagmi/core 2.16.4 guards itself with a module-level
 * `isReconnecting` flag that only the first call per process gets past, so a
 * second restore anywhere in the same file silently resolves to nothing and the
 * assertion would pass or fail for reasons that have nothing to do with this
 * code. node:test gives each file its own process, which is the isolation the
 * flag needs. Do not merge this back into `wallet.test.mjs`.
 *
 * The failure direction — a wallet that refuses to come back — is deliberately
 * not tested here: the mock connector reports `defaultConnected` through its
 * emitter rather than through `connect`, so it reconnects even when told to
 * fail, and any assertion about it would pass for the wrong reason.
 */

const ACCOUNT = "0x1111111111111111111111111111111111111111";

const chain = {
  id: 11155111,
  name: "Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.example/sepolia"] } },
};

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
  };
}

function wallet(features = {}) {
  return mock({ accounts: [ACCOUNT], features: { reconnect: true, ...features } });
}

/**
 * The same wallet as seen after a page reload: still holding the site's
 * permission, which is what wagmi asks a connector before restoring it.
 */
function stillAuthorized(features = {}) {
  return wallet({ defaultConnected: true, ...features });
}

function build(connectors, storage) {
  return createWallet({ chain, storage, connectors });
}

test("restores the last working wallet across a reload", async () => {
  const storage = fakeStorage();
  const first = build([wallet()], storage);
  await first.connectTo(first.available()[0].uid);

  const reloaded = build([stillAuthorized()], storage);
  assert.equal(reloaded.account(), "");
  await reloaded.restore();

  assert.equal(reloaded.account(), ACCOUNT);
});
