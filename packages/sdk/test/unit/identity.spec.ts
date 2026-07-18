import { describe, it, expect } from "vitest";
import { poseidon } from "maci-crypto/build/ts/hashing.js";
import { mnemonicToAccount } from "viem/accounts";
import { bytesToBigInt, bytesToNumber } from "viem/utils";
import { subOrder } from "@zk-kit/baby-jubjub";

import {
  ERC6538_REGISTRY,
  SHIELDED_SCHEME_ID,
  decodeShieldedMetaAddress,
  encodeShieldedMetaAddress,
  generateShieldedKeys,
  generateVaultKey,
  nextDepositIndex,
  recoverNotes,
  shieldedAddress,
} from "../../src/identity.js";
import {
  generateDepositSecrets,
  generateMasterKeys,
  hashPrecommitment,
} from "../../src/crypto.js";
import { NoteService } from "../../src/core/note.service.js";
import { Hash } from "../../src/types/commitment.js";

const MNEMONIC =
  "test test test test test test test test test test test junk";
const OTHER =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";
const SCOPE = 1072257550380742535619809584692670747078661758898091403955338665663319571310n as Hash;

/** The pool's commitment: Poseidon(value, label, precommitment). */
const commitmentOf = (value: bigint, label: bigint, pre: bigint) =>
  poseidon([value, label, pre]) as unknown as bigint;

/** Fabricate the on-chain Deposited events a mnemonic would have produced. */
function depositsFor(mnemonic: string, indices: bigint[], value = 1_000n) {
  const keys = generateMasterKeys(mnemonic);
  return indices.map((index) => {
    const { nullifier, secret } = generateDepositSecrets(keys, SCOPE, index);
    const precommitment = hashPrecommitment(nullifier, secret) as bigint;
    const label = 700n + index;
    return {
      commitment: commitmentOf(value, label, precommitment),
      label,
      value,
      precommitment,
    };
  });
}

describe("shielded keys derive from the mnemonic, not the wallet", () => {
  it("is deterministic for a mnemonic", () => {
    expect(generateShieldedKeys(MNEMONIC)).toEqual(generateShieldedKeys(MNEMONIC));
  });

  it("gives a different identity for a different mnemonic", () => {
    const a = generateShieldedKeys(MNEMONIC);
    const b = generateShieldedKeys(OTHER);
    expect(a.b).not.toBe(b.b);
    expect(a.v).not.toBe(b.v);
  });

  it("keeps spend and view keys independent (watch-only is possible)", () => {
    const { b, v } = generateShieldedKeys(MNEMONIC);
    expect(b).not.toBe(v);
  });

  it("produces valid non-zero Baby Jubjub scalars", () => {
    const { b, v } = generateShieldedKeys(MNEMONIC);
    for (const scalar of [b, v] as bigint[]) {
      expect(scalar).toBeGreaterThan(0n);
      expect(scalar).toBeLessThan(subOrder);
    }
  });

  it("publishes only the public half", () => {
    const keys = generateShieldedKeys(MNEMONIC);
    const published = shieldedAddress(MNEMONIC);
    expect(published).toEqual({ B: keys.B, V: keys.V });
    expect(published).not.toHaveProperty("b");
    expect(published).not.toHaveProperty("v");
  });

  it("derives a vault key distinct from the shielded keys", () => {
    const vault = generateVaultKey(MNEMONIC);
    expect(vault).toMatch(/^0x[0-9a-f]{64}$/);
    expect(generateVaultKey(MNEMONIC)).toBe(vault);
    expect(generateVaultKey(OTHER)).not.toBe(vault);
  });
});

describe("ERC-6538 meta-address", () => {
  it("never uses schemeId 1 — that would be secp256k1 and misdirect 5564 wallets", () => {
    expect(SHIELDED_SCHEME_ID).not.toBe(1n);
    expect(ERC6538_REGISTRY).toBe("0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538");
  });

  it("round-trips a shielded address through the registry blob", () => {
    const address = shieldedAddress(MNEMONIC);
    const encoded = encodeShieldedMetaAddress(address);
    expect(encoded).toHaveLength(2 + 256); // 128 bytes
    expect(decodeShieldedMetaAddress(encoded)).toEqual(address);
  });

  it("rejects a malformed blob rather than yielding a garbage point", () => {
    expect(() => decodeShieldedMetaAddress("0xdeadbeef")).toThrow();
  });

  it("a sender who resolves the blob can pay the recipient who owns the mnemonic", () => {
    // Sender: only ever sees the registry blob.
    const resolved = decodeShieldedMetaAddress(
      encodeShieldedMetaAddress(shieldedAddress(MNEMONIC)),
    );
    const notes = new NoteService();
    const sent = notes.buildDestNote(resolved, 4_500n, 555_555n);

    // Recipient: derives keys from the mnemonic and scans.
    const found = notes.scanL2Notes(
      [{
        commitment: sent.cDest,
        value: 4_500n,
        ephemeralKey: sent.ephemeralKey,
        viewTag: `0x${sent.viewTag.toString(16).padStart(2, "0")}`,
      }],
      generateShieldedKeys(MNEMONIC),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.cDest).toBe(sent.cDest);

    // Somebody else's mnemonic must not match it.
    expect(
      notes.scanL2Notes(
        [{
          commitment: sent.cDest,
          value: 4_500n,
          ephemeralKey: sent.ephemeralKey,
          viewTag: `0x${sent.viewTag.toString(16).padStart(2, "0")}`,
        }],
        generateShieldedKeys(OTHER),
      ),
    ).toHaveLength(0);
  });
});

describe("L1 note recovery — the vault is a cache, not the source of truth", () => {
  it("rebuilds every note from chain data alone", () => {
    const deposits = depositsFor(MNEMONIC, [0n, 1n, 2n]);
    const recovered = recoverNotes(MNEMONIC, SCOPE, deposits);

    expect(recovered.map((n) => n.index)).toEqual([0n, 1n, 2n]);
    // The recovered secrets must actually open the on-chain commitments.
    for (const note of recovered) {
      const deposit = deposits.find((d) => d.commitment === note.commitment)!;
      expect(hashPrecommitment(note.nullifier, note.secret) as bigint).toBe(
        deposit.precommitment,
      );
    }
  });

  it("ignores deposits belonging to a different mnemonic", () => {
    const mine = depositsFor(MNEMONIC, [0n, 1n]);
    const theirs = depositsFor(OTHER, [0n, 1n, 2n]);
    const recovered = recoverNotes(MNEMONIC, SCOPE, [...theirs, ...mine]);

    expect(recovered).toHaveLength(2);
    expect(recoverNotes(OTHER, SCOPE, [...theirs, ...mine])).toHaveLength(3);
  });

  it("walks past a gap instead of stopping at the first miss", () => {
    // Index 1 was derived but its deposit never landed (reverted tx).
    const deposits = depositsFor(MNEMONIC, [0n, 2n, 3n]);
    const recovered = recoverNotes(MNEMONIC, SCOPE, deposits);
    expect(recovered.map((n) => n.index)).toEqual([0n, 2n, 3n]);
  });

  it("finds nothing in an empty pool", () => {
    expect(recoverNotes(MNEMONIC, SCOPE, [])).toEqual([]);
  });

  it("hands a new deposit an unused index, derived from chain not a local counter", () => {
    expect(nextDepositIndex(MNEMONIC, SCOPE, [])).toBe(0n);
    expect(nextDepositIndex(MNEMONIC, SCOPE, depositsFor(MNEMONIC, [0n, 1n]))).toBe(2n);
    // Two devices sharing a mnemonic must not collide on an index: reusing one
    // reproduces the same precommitment and the pool reverts PrecommitmentAlreadyUsed.
    const deposits = depositsFor(MNEMONIC, [0n, 1n, 2n]);
    const next = nextDepositIndex(MNEMONIC, SCOPE, deposits);
    const keys = generateMasterKeys(MNEMONIC);
    const { nullifier, secret } = generateDepositSecrets(keys, SCOPE, next);
    const fresh = hashPrecommitment(nullifier, secret) as bigint;
    expect(deposits.some((d) => d.precommitment === fresh)).toBe(false);
  });
});

describe("master keys use the FULL 32 bytes of HD entropy", () => {
  /**
   * Regression guard for a silent, catastrophic entropy loss.
   *
   * `generateMasterKeys` used viem's `bytesToNumber`, which returns a JS `number`
   * — an IEEE-754 double. A 256-bit key is ~7.8e76, far past MAX_SAFE_INTEGER, so
   * the double kept only its 53-bit mantissa and rounded, zeroing the low ~203
   * bits. The master keys had ~53 bits of entropy instead of 256, and the value
   * hashed was not even the real private key.
   *
   * Nothing threw. The only way to see it is to compare against the raw bytes.
   */
  const hdKey = (index: number) =>
    mnemonicToAccount(MNEMONIC, { accountIndex: index }).getHdKey().privateKey!;

  it("hashes the true private key, not a rounded double", () => {
    const keys = generateMasterKeys(MNEMONIC);
    expect(keys.masterNullifier as bigint).toBe(poseidon([bytesToBigInt(hdKey(0))]));
    expect(keys.masterSecret as bigint).toBe(poseidon([bytesToBigInt(hdKey(1))]));
  });

  it("the lossy conversion really does destroy the key (why this guard exists)", () => {
    const raw = hdKey(0);
    const exact = bytesToBigInt(raw);
    const rounded = BigInt(bytesToNumber(raw));

    expect(rounded).not.toBe(exact);
    // The low ~203 bits are gone: the double can only land on multiples of 2^203.
    expect(rounded % (2n ** 200n)).toBe(0n);
    expect(exact % (2n ** 200n)).not.toBe(0n);
    // And so it would have produced a completely different master key.
    expect(poseidon([rounded])).not.toBe(poseidon([exact]));
  });

  it("distinct HD accounts give distinct, full-entropy masters", () => {
    const keys = generateMasterKeys(MNEMONIC);
    expect(keys.masterNullifier).not.toBe(keys.masterSecret);
    expect(bytesToBigInt(hdKey(0))).not.toBe(bytesToBigInt(hdKey(1)));
  });
});
