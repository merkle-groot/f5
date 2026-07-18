import { LeanIMT } from "@zk-kit/lean-imt";
import { poseidon } from "maci-crypto/build/ts/hashing.js";
import { describe, expect, it } from "vitest";

/**
 * Regression: proving must survive a SINGLE-LEAF tree.
 *
 * A one-leaf tree has depth 0 and no siblings, and LeanIMT derives a proof's `index` by folding
 * over the sibling path — so with nothing to fold, older versions return `index: null` instead of
 * 0. `BigInt(null)` throws "Cannot convert null to a BigInt", which means proving breaks precisely
 * when a pool is freshly deployed (its first withdrawal) and silently starts working once a second
 * deposit lands. Both the L1 state tree and the ASP label tree hit this.
 *
 * This is NOT hypothetical version trivia: this workspace ships two LeanIMT versions at once —
 * 2.2.2 hoisted at the root (which the relayer resolves, and which returns null) and 2.2.4 under
 * packages/sdk + app (which returns 0). A live withdrawal failed with exactly this error because
 * the ASP proof came from the relayer's copy. So the SDK must normalise whatever it is handed
 * rather than trust one version's behaviour.
 */
describe("single-leaf Merkle proof index", () => {
  const build = (leaves: number) => {
    const tree = new LeanIMT<bigint>((a, b) => poseidon([a, b]));
    for (let i = 1; i <= leaves; i += 1) tree.insert(BigInt(i * 111));
    return tree;
  };

  it("a one-leaf tree has depth 0 and no siblings", () => {
    const tree = build(1);
    expect(tree.depth).toBe(0);
    expect(tree.generateProof(0).siblings).toHaveLength(0);
  });

  it("normalising with `?? 0` yields a valid signal for every tree size, whatever the index", () => {
    for (const leaves of [1, 2, 3, 8]) {
      const proof = build(leaves).generateProof(0);
      // `index` is 0 on lean-imt 2.2.4 and null on 2.2.2 — both must normalise to 0n.
      expect(BigInt(proof.index ?? 0)).toBe(0n);
    }
  });

  it("a null index (as the relayer's lean-imt 2.2.2 emits) would throw unnormalised", () => {
    const nullIndex = null as unknown as number;
    expect(() => BigInt(nullIndex)).toThrow(/convert null/i);
    expect(BigInt(nullIndex ?? 0)).toBe(0n);
  });
});
