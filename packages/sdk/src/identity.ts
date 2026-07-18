import { mnemonicToAccount } from "viem/accounts";
import { keccak256, toHex, type Hex } from "viem";
import { subOrder } from "@zk-kit/baby-jubjub";

import {
  generateDepositSecrets,
  generateMasterKeys,
  hashPrecommitment,
} from "./crypto.js";
import { ErrorCode, SDKError } from "./errors/base.error.js";
import { derivePublicKey } from "./stealth.js";
import { Hash, Secret } from "./types/commitment.js";
import { ShieldedAddress, ShieldedKeys } from "./types/stealth.js";

/**
 * One mnemonic is the single root of a Cutout identity.
 *
 * Everything else is derived from it, so the mnemonic is the ONLY thing a user
 * has to back up:
 *
 *   - L1 note secrets  — `generateMasterKeys` (HD accounts 0, 1), which makes
 *     deposits re-derivable and turns the local note vault into a cache rather
 *     than the source of truth;
 *   - shielded keys `(b, v)` — HD accounts 2, 3 (here);
 *   - the vault encryption key — HD account 4 (here).
 *
 * Nothing is derived from a wallet signature. That matters: signatures are only
 * deterministic for RFC-6979 signers, and plenty of smart-contract wallets and
 * WalletConnect implementations are not — a signature that comes back different
 * once would mean keys that can never be re-derived. A wallet may still be used
 * to *unwrap* a stored mnemonic, but it is never the root of any key.
 */

/** HD account indices. 0 and 1 belong to `generateMasterKeys` — do not reuse. */
const HD_SPEND_KEY = 2;
const HD_VIEW_KEY = 3;
const HD_VAULT_KEY = 4;

/**
 * The ERC-6538 `schemeId` under which a Cutout meta-address is published.
 *
 * It MUST NOT be 1. SchemeId 1 is secp256k1 + keccak, where the stealth address
 * is a real Ethereum address in the value path. Ours is Baby Jubjub + Poseidon
 * and `P` is never an Ethereum address at all — it is a curve point that opens a
 * Poseidon commitment in-circuit. Registering our blob under schemeId 1 would
 * make a conformant ERC-5564 wallet parse it as secp256k1 keys and send real
 * funds to a garbage address. A domain-separated id keeps conformant tooling
 * correctly ignoring us (CLAUDE.md §2).
 */
export const SHIELDED_SCHEME_ID: bigint = BigInt(
  keccak256(toHex("cutout.babyjubjub.poseidon.v1")),
);

/** The canonical ERC-6538 Stealth Meta-Address Registry (same address on Sepolia). */
export const ERC6538_REGISTRY = "0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538" as const;

function hdPrivateKey(mnemonic: string, accountIndex: number): bigint {
  if (!mnemonic) {
    throw new SDKError(
      "Invalid input: mnemonic phrase is required.",
      ErrorCode.INVALID_INPUT,
    );
  }
  const key = mnemonicToAccount(mnemonic, { accountIndex }).getHdKey().privateKey;
  if (!key) {
    throw new SDKError(
      `Unable to derive HD key at account index ${accountIndex}.`,
      ErrorCode.INVALID_INPUT,
    );
  }
  return BigInt(
    `0x${Array.from(key, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
  );
}

/**
 * Reduce a 256-bit HD key into the Baby Jubjub prime-order subgroup.
 *
 * The modulo bias is negligible (`subOrder` is ~2^251, so the bias is ~2^-5 on
 * the top bits of a uniform 256-bit input, and utterly irrelevant at this
 * scalar size), and this is the standard way to turn HD entropy into a curve
 * scalar. A zero scalar would be a degenerate key, so reject it.
 */
function toCurveScalar(raw: bigint, name: string): Secret {
  const scalar = raw % subOrder;
  if (scalar === 0n) {
    throw new SDKError(
      `Derived ${name} reduced to zero; use a different mnemonic.`,
      ErrorCode.INVALID_INPUT,
    );
  }
  return scalar as Secret;
}

/**
 * Derive the shielded keypairs `(b, B)` and `(v, V)` from the mnemonic.
 *
 * `v` alone is enough to SCAN for notes; `b` is required to SPEND one. A
 * watch-only setup can therefore hold `v` without `b` — which is why they are
 * separate HD accounts rather than one key split two ways.
 */
export function generateShieldedKeys(mnemonic: string): ShieldedKeys {
  const b = toCurveScalar(hdPrivateKey(mnemonic, HD_SPEND_KEY), "spend key");
  const v = toCurveScalar(hdPrivateKey(mnemonic, HD_VIEW_KEY), "view key");
  return { b, B: derivePublicKey(b), v, V: derivePublicKey(v) };
}

/**
 * The recipient's published shielded address — the public half only.
 * Safe to hand out; it is what a sender needs and all a sender may have.
 */
export function shieldedAddress(mnemonic: string): ShieldedAddress {
  const { B, V } = generateShieldedKeys(mnemonic);
  return { B, V };
}

/**
 * 32 bytes of key material for encrypting the local note vault at rest.
 *
 * Domain-separated from the HD key itself so that a leak of this value cannot be
 * walked back to the account-4 private key.
 */
export function generateVaultKey(mnemonic: string): Hex {
  const raw = hdPrivateKey(mnemonic, HD_VAULT_KEY);
  return keccak256(
    toHex(`f5.vault.v1:${raw.toString(16)}`),
  );
}

/**
 * ERC-6538 meta-address encoding: `B.x ‖ B.y ‖ V.x ‖ V.y`, each a 32-byte
 * big-endian field element (128 bytes total).
 *
 * Points are stored UNCOMPRESSED. Baby Jubjub points do compress to 32 bytes,
 * but decompression needs a modular square root — an extra failure mode on the
 * read path in exchange for 64 bytes in a registry write. Not worth it.
 */
export function encodeShieldedMetaAddress(address: ShieldedAddress): Hex {
  const word = (value: bigint) => value.toString(16).padStart(64, "0");
  return `0x${word(address.B[0])}${word(address.B[1])}${word(address.V[0])}${word(address.V[1])}`;
}

/** Inverse of {@link encodeShieldedMetaAddress}. Throws on a malformed blob. */
export function decodeShieldedMetaAddress(encoded: Hex): ShieldedAddress {
  const raw = encoded.startsWith("0x") ? encoded.slice(2) : encoded;
  if (raw.length !== 256 || !/^[0-9a-fA-F]+$/.test(raw)) {
    throw new SDKError(
      `Invalid shielded meta-address: expected 128 bytes, got ${raw.length / 2}.`,
      ErrorCode.INVALID_INPUT,
    );
  }
  const word = (index: number) =>
    BigInt(`0x${raw.slice(index * 64, index * 64 + 64)}`);
  return {
    B: [word(0), word(1)],
    V: [word(2), word(3)],
  };
}

/**
 * The minimal on-chain deposit data needed to recover a note by derivation.
 * Matches `DepositEvent` from the indexer.
 */
export interface RecoverableDeposit {
  readonly commitment: bigint;
  readonly label: bigint;
  readonly value: bigint;
  readonly precommitment: bigint;
}

/** An L1 note reconstructed from the mnemonic — never read from local storage. */
export interface RecoveredNote {
  readonly index: bigint;
  readonly commitment: bigint;
  readonly label: bigint;
  readonly value: bigint;
  readonly nullifier: Secret;
  readonly secret: Secret;
  readonly precommitment: bigint;
}

/**
 * Rebuild every L1 note this mnemonic owns, from chain data alone.
 *
 * Deposit secrets are `Poseidon(master, scope, index)`, so the notes for a
 * mnemonic are a deterministic sequence — we walk indices, derive each
 * precommitment, and look it up among the pool's `Deposited` events. This is
 * what makes the encrypted local vault a CACHE rather than the source of truth:
 * lose `localStorage` and the notes are still recoverable from twelve words.
 *
 * `gapLimit` mirrors the BIP-44 convention: keep scanning past a miss, and only
 * stop after that many consecutive unused indices. Without it, a single skipped
 * index (a deposit that reverted after its secrets were derived) would hide
 * every note after it.
 */
export function recoverNotes(
  mnemonic: string,
  scope: Hash,
  deposits: readonly RecoverableDeposit[],
  gapLimit = 20,
): RecoveredNote[] {
  const keys = generateMasterKeys(mnemonic);
  const byPrecommitment = new Map<bigint, RecoverableDeposit>();
  for (const deposit of deposits) {
    byPrecommitment.set(deposit.precommitment, deposit);
  }

  const found: RecoveredNote[] = [];
  for (let index = 0n, gap = 0; gap < gapLimit; index += 1n) {
    const { nullifier, secret } = generateDepositSecrets(keys, scope, index);
    const precommitment = hashPrecommitment(nullifier, secret);
    const deposit = byPrecommitment.get(precommitment as bigint);

    if (!deposit) {
      gap += 1;
      continue;
    }

    gap = 0;
    found.push({
      index,
      commitment: deposit.commitment,
      label: deposit.label,
      value: deposit.value,
      nullifier,
      secret,
      precommitment: precommitment as bigint,
    });
  }

  return found;
}

/**
 * The index a NEW deposit should use: one past the highest index this mnemonic
 * has already used in this scope. Derived from chain state, not from a local
 * counter, so two devices sharing a mnemonic can't collide on an index (which
 * would produce a duplicate precommitment and revert with
 * `PrecommitmentAlreadyUsed`).
 */
export function nextDepositIndex(
  mnemonic: string,
  scope: Hash,
  deposits: readonly RecoverableDeposit[],
  gapLimit = 20,
): bigint {
  const notes = recoverNotes(mnemonic, scope, deposits, gapLimit);
  return notes.length ? notes[notes.length - 1]!.index + 1n : 0n;
}
