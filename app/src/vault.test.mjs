import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";

globalThis.crypto ??= webcrypto;

function storageStub() {
  const values = new Map();
  return {
    get length() { return values.size; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    key(index) { return [...values.keys()][index] ?? null; },
    raw(key) { return values.get(key); },
  };
}

globalThis.localStorage = storageStub();

const { forgetIdentity, loadL2Scan, saveL2Scan } = await import("./vault.js");
const vaultKey = `0x${"11".repeat(32)}`;

test("L2 scan cache round-trips bigint spend material under the current scope", async () => {
  const note = {
    cDest: 101n,
    value: 202n,
    sharedSecretX: 303n,
    stealthPrivKey: 404n,
    nullifier: 505n,
    chain: "base",
    _status: "spendable",
    bridgedAt: 1_753_009_200_000,
  };

  await saveL2Scan(vaultKey, "scope-a", { notes: [note], scannedCount: 9 });
  const restored = await loadL2Scan(vaultKey, "scope-a");

  assert.deepEqual(restored, { notes: [note], scannedCount: 9 });
  assert.doesNotMatch(localStorage.raw("f5-l2-scan-v1"), /base|spendable|scope-a/);
});

test("L2 scan cache rejects another deployment scope and is cleared with the identity", async () => {
  await saveL2Scan(vaultKey, "scope-a", { notes: [], scannedCount: 4 });
  assert.deepEqual(await loadL2Scan(vaultKey, "scope-b"), { notes: [], scannedCount: 0 });

  forgetIdentity();
  assert.equal(localStorage.getItem("f5-l2-scan-v1"), null);
});
