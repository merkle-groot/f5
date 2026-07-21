import assert from "node:assert/strict";
import test from "node:test";
import { mock } from "@wagmi/core";
import { createWallet } from "./wallet.js";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

const chain = {
  id: 11155111,
  name: "Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.example/sepolia"] } },
};

/** In-memory `localStorage`, so a "reload" is just a second `createWallet`. */
function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
  };
}

/**
 * A wallet that connects, and that agrees to be reconnected — wagmi only
 * restores connectors that report themselves authorized, and the mock reports
 * that from `features.reconnect`. `connectError` makes one that cannot connect.
 */
function wallet(accounts, features = {}) {
  return mock({ accounts, features: { reconnect: true, ...features } });
}

function build(connectors, storage = fakeStorage(), onChange) {
  return createWallet({ chain, storage, connectors, onChange });
}

test("lists every installed wallet for the picker", () => {
  const wallets = build([wallet([ACCOUNT]), wallet([OTHER])]);

  assert.equal(wallets.available().length, 2);
  assert.ok(wallets.available()[0].uid);
});

// The whole point of the change: two wallets installed used to mean the user
// silently got whichever one won the `window.ethereum` race.
test("connects to the wallet the user picked, not the first one", async () => {
  const wallets = build([wallet([ACCOUNT]), wallet([OTHER])]);
  const [, second] = wallets.available();

  const connected = await wallets.connectTo(second.uid);

  assert.equal(connected, OTHER);
  assert.equal(wallets.account(), OTHER);
});

// The bug that made a wallet stick: an installed-but-unconfigured wallet was
// recorded as the choice, and every later attempt walked back into it.
// The bug that made a wallet stick: an installed-but-unconfigured wallet was
// recorded as the choice, and every later attempt walked back into it. The
// across-a-reload half of this claim lives in `wallet-restore.test.mjs`.
test("a wallet that fails to connect leaves the user free to pick another", async () => {
  const broken = wallet([ACCOUNT], { connectError: true });
  const working = wallet([OTHER]);
  const wallets = build([broken, working]);

  await assert.rejects(() => wallets.connectTo(wallets.available()[0].uid));
  assert.equal(wallets.account(), "");

  assert.equal(await wallets.connectTo(wallets.available()[1].uid), OTHER);
});

test("disconnecting clears the account and frees the picker", async () => {
  const wallets = build([wallet([ACCOUNT]), wallet([OTHER])]);
  await wallets.connectTo(wallets.available()[0].uid);

  await wallets.release();

  assert.equal(wallets.account(), "");
  assert.equal(await wallets.connectTo(wallets.available()[1].uid), OTHER);
});

test("reports the connected chain, and nothing when disconnected", async () => {
  const wallets = build([wallet([ACCOUNT])]);
  assert.equal(wallets.chainId(), null);

  await wallets.connectTo(wallets.available()[0].uid);
  assert.equal(wallets.chainId(), chain.id);
});

test("refuses a wallet that has since disappeared", async () => {
  const wallets = build([wallet([ACCOUNT])]);

  await assert.rejects(() => wallets.connectTo("gone"), /no longer available/);
});

// The UI mirrors wagmi's connection into its own `state`, so it has to be told
// when that connection moves.
test("notifies on connect and on disconnect", async () => {
  let changes = 0;
  const wallets = build([wallet([ACCOUNT])], fakeStorage(), () => { changes += 1; });

  await wallets.connectTo(wallets.available()[0].uid);
  assert.ok(changes > 0);

  const afterConnect = changes;
  await wallets.release();
  assert.ok(changes > afterConnect);
});
