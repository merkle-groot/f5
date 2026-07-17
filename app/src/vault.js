import { generateMnemonic, english } from "viem/accounts";
import { validateMnemonic } from "@scure/bip39";

/**
 * Local identity + note storage.
 *
 * The mnemonic is the single root: it derives the L1 note secrets, the shielded
 * keys (b, v), and the key this vault is encrypted with. Nothing here is derived
 * from a wallet signature — a wallet may UNWRAP the stored mnemonic, but it is
 * never the source of a key. That distinction is the whole safety margin: if the
 * signature is non-deterministic, or you switch wallets, you are not locked out,
 * because the written-down mnemonic still recovers everything.
 *
 * Two unwrap methods:
 *   - wallet   — sign a fixed message; keeps the one-click UX for depositors.
 *   - password — PBKDF2; lets a pure recipient use RECEIVE with no EOA at all,
 *                which is the point of a stealth address.
 *
 * The note cache is exactly that: a CACHE. Deposit secrets are
 * `Poseidon(master, scope, index)`, so notes are re-derivable from the mnemonic
 * plus public chain data (see `recoverNotes`). Losing this storage is survivable.
 */

const IDENTITY_KEY = "f5-identity-v1";
const NOTES_KEY = "f5-notes-v1";
const L2_HISTORY_KEY = "f5-l2-history-v1";
const LEGACY_NOTE_PREFIX = "f5-note-";

export const IDENTITY_UNWRAP_MESSAGE =
  "F5 identity — sign once to unlock your shielded identity on this device.";
/** Pre-mnemonic vaults encrypted each note directly under a wallet signature. */
const LEGACY_MESSAGES = [
  "F5 note vault key — sign once to unlock your local notes.",
  "F5 note vault key — sign once to encrypt this note locally.",
];

const enc = new TextEncoder();
const dec = new TextDecoder();

export function createMnemonic() {
  return generateMnemonic(english);
}

/** Normalize and validate a 12-word English BIP-39 phrase, including its checksum. */
export function validateRecoveryPhrase(value) {
  const mnemonic = String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const words = mnemonic ? mnemonic.split(" ") : [];
  if (words.length !== 12) throw new Error(`Enter exactly 12 words. Found ${words.length}.`);

  const wordlist = new Set(english);
  const unknown = [...new Set(words.filter((word) => !wordlist.has(word)))];
  if (unknown.length) {
    throw new Error(`Not ${unknown.length === 1 ? "a BIP-39 English word" : "BIP-39 English words"}: ${unknown.join(", ")}.`);
  }
  if (!validateMnemonic(mnemonic, english)) {
    throw new Error("Those words do not form a valid BIP-39 phrase. Check their spelling and order.");
  }
  return mnemonic;
}

export function hasIdentity() {
  return Boolean(localStorage.getItem(IDENTITY_KEY));
}

export function identityUnwrapKind() {
  try {
    return JSON.parse(localStorage.getItem(IDENTITY_KEY))?.kdf ?? null;
  } catch {
    return null;
  }
}

export function forgetIdentity() {
  localStorage.removeItem(IDENTITY_KEY);
  localStorage.removeItem(NOTES_KEY);
}

/*//////////////////////////////////////////////////////////////
                          UNWRAP KEYS
//////////////////////////////////////////////////////////////*/

async function keyFromSignature(signature, usages) {
  const bytes = new Uint8Array(signature.slice(2).match(/.{1,2}/g).map((b) => parseInt(b, 16)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, usages);
}

async function keyFromPassword(password, salt, usages) {
  const material = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 250_000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

/** AES key from the mnemonic-derived vault key (hex from the SDK). */
async function keyFromVaultHex(vaultKeyHex, usages) {
  const bytes = new Uint8Array(vaultKeyHex.slice(2).match(/.{1,2}/g).map((b) => parseInt(b, 16)));
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, usages);
}

async function encryptJson(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(value)));
  return { iv: [...iv], ciphertext: [...new Uint8Array(ciphertext)] };
}

async function decryptJson(key, envelope) {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(envelope.iv) },
    key,
    new Uint8Array(envelope.ciphertext),
  );
  return JSON.parse(dec.decode(plaintext));
}

/*//////////////////////////////////////////////////////////////
                        MNEMONIC AT REST
//////////////////////////////////////////////////////////////*/

/**
 * @param unwrap {kind:"wallet", signature} | {kind:"password", password}
 */
export async function saveMnemonic(mnemonic, unwrap) {
  let envelope;
  let extra;
  if (unwrap.kind === "password") {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    envelope = await encryptJson(await keyFromPassword(unwrap.password, salt, ["encrypt"]), mnemonic);
    extra = { salt: [...salt] };
  } else {
    envelope = await encryptJson(await keyFromSignature(unwrap.signature, ["encrypt"]), mnemonic);
    extra = {};
  }
  localStorage.setItem(IDENTITY_KEY, JSON.stringify({ version: 1, kdf: unwrap.kind, ...envelope, ...extra }));
}

export async function loadMnemonic(unwrap) {
  const stored = JSON.parse(localStorage.getItem(IDENTITY_KEY) ?? "null");
  if (!stored) throw new Error("No shielded identity on this device.");
  if (stored.kdf !== unwrap.kind) {
    throw new Error(`This identity is unlocked with a ${stored.kdf === "password" ? "password" : "wallet signature"}.`);
  }
  const key = unwrap.kind === "password"
    ? await keyFromPassword(unwrap.password, new Uint8Array(stored.salt), ["decrypt"])
    : await keyFromSignature(unwrap.signature, ["decrypt"]);
  try {
    return await decryptJson(key, stored);
  } catch {
    throw new Error(unwrap.kind === "password" ? "Wrong password." : "That wallet cannot unlock this identity.");
  }
}

/*//////////////////////////////////////////////////////////////
                          NOTE CACHE
//////////////////////////////////////////////////////////////*/

/**
 * Persist the note cache, stamped with the pool `scope` it belongs to.
 *
 * A note only means anything against the pool it was deposited into: its secrets are
 * `Poseidon(master, scope, index)` and its commitment lives in that pool's tree. Redeploy the pool
 * and every cached note becomes undeadable — but this cache is browser-local, so nothing on-chain
 * invalidates it. Without the stamp the Vault happily lists notes from a previous deployment as
 * spendable, and the only symptom is a confusing failure deep in the proving path.
 */
export async function saveNotes(vaultKeyHex, scope, notes) {
  const key = await keyFromVaultHex(vaultKeyHex, ["encrypt"]);
  localStorage.setItem(NOTES_KEY, JSON.stringify(await encryptJson(key, { scope: String(scope), notes })));
}

/**
 * Load the note cache for `scope`, discarding notes belonging to any other deployment.
 *
 * Returns `[]` rather than throwing on a stale/unreadable cache: notes are re-derivable from the
 * mnemonic via `recoverNotes`, so dropping the cache is always safe.
 */
export async function loadNotes(vaultKeyHex, scope) {
  const stored = JSON.parse(localStorage.getItem(NOTES_KEY) ?? "null");
  if (!stored) return [];
  try {
    const decrypted = await decryptJson(await keyFromVaultHex(vaultKeyHex, ["decrypt"]), stored);
    // Pre-stamp caches were a bare array with no scope. They cannot be attributed to a pool, so
    // treat them as stale rather than guessing.
    if (Array.isArray(decrypted)) return [];
    if (String(decrypted.scope) !== String(scope)) return [];
    return decrypted.notes ?? [];
  } catch {
    return [];
  }
}

/*//////////////////////////////////////////////////////////////
                        L2 WITHDRAWAL HISTORY
//////////////////////////////////////////////////////////////*/

/**
 * A record of destination notes the user has already WITHDRAWN, keyed by their
 * `C_dest` commitment: `{ [cDest]: { value, chain, recipient, hash, at } }`.
 *
 * Unlike an L1 note (re-derivable from the mnemonic), a delivered L2 note the
 * user has already spent leaves no local trace once it is proven — the on-chain
 * status endpoint only reports `activated`, never `withdrawn`. So the "landed"
 * half of the portfolio is remembered here. It is best-effort and per-device: a
 * fresh browser re-learns nothing about past withdrawals, which is acceptable —
 * this is display history, never a spend authority.
 */
export async function saveL2History(vaultKeyHex, scope, history) {
  const key = await keyFromVaultHex(vaultKeyHex, ["encrypt"]);
  localStorage.setItem(L2_HISTORY_KEY, JSON.stringify(await encryptJson(key, { scope: String(scope), history })));
}

/**
 * Scoped like the note cache: a `C_dest` only exists in the destination pool it was delivered to,
 * and those are redeployed whenever the L1 pool changes (they bind `l1Pool` immutably). History
 * from a previous deployment would show withdrawals against notes that no longer exist.
 */
export async function loadL2History(vaultKeyHex, scope) {
  const stored = JSON.parse(localStorage.getItem(L2_HISTORY_KEY) ?? "null");
  if (!stored) return {};
  try {
    const decrypted = await decryptJson(await keyFromVaultHex(vaultKeyHex, ["decrypt"]), stored);
    if (!decrypted || typeof decrypted !== "object") return {};
    // Pre-stamp caches were a bare map; unattributable, so treat as stale.
    if (!("scope" in decrypted) || !("history" in decrypted)) return {};
    if (String(decrypted.scope) !== String(scope)) return {};
    return decrypted.history ?? {};
  } catch {
    return {};
  }
}

/*//////////////////////////////////////////////////////////////
                        LEGACY MIGRATION
//////////////////////////////////////////////////////////////*/

export function hasLegacyNotes() {
  for (let i = 0; i < localStorage.length; i += 1) {
    if (localStorage.key(i)?.startsWith(LEGACY_NOTE_PREFIX)) return true;
  }
  return false;
}

/**
 * Import notes written before the mnemonic existed. Their secrets were pure
 * local entropy, so they are NOT re-derivable — if we cannot decrypt them here
 * they are gone forever. Both historical vault messages are tried.
 *
 * @param signFn (message) => Promise<signature>
 */
export async function importLegacyNotes(signFn, wallet) {
  const found = [];
  for (const message of LEGACY_MESSAGES) {
    let key;
    try {
      key = await keyFromSignature(await signFn(message), ["decrypt"]);
    } catch {
      continue;
    }
    for (let i = 0; i < localStorage.length; i += 1) {
      const storageKey = localStorage.key(i);
      if (!storageKey?.startsWith(LEGACY_NOTE_PREFIX)) continue;
      try {
        const envelope = JSON.parse(localStorage.getItem(storageKey));
        if (envelope.wallet?.toLowerCase() !== wallet.toLowerCase()) continue;
        const note = await decryptJson(key, envelope);
        if (!found.some((n) => n.commitment === note.commitment)) found.push({ ...note, legacy: true });
      } catch { /* encrypted by a different wallet or message */ }
    }
    if (found.length) break;
  }
  return found;
}
