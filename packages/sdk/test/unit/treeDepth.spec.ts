import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_TREE_DEPTH } from "../../src/core/withdrawal.service.js";

/**
 * `MAX_TREE_DEPTH` is a COPY of a value owned elsewhere: the circuits' `maxTreeDepth` param and the
 * pool's on-chain `MAX_TREE_DEPTH`. The SDK cannot read either at runtime (the browser has no repo),
 * so the copy is pinned here by reading BOTH sources off disk.
 *
 * This is deliberately not a comparison between two hand-written constants — that kind of test
 * passes happily while the protocol is dead. If someone re-parameterises the circuit, this fails.
 *
 * Why it matters: the circuits declare `signal input stateSiblings[maxTreeDepth]`, a fixed-size
 * array. Padding to the wrong length either fails proving outright ("Not enough values for input
 * signal stateSiblings") or, worse, silently proves against a shape the verifier rejects.
 */
const repoFile = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), "utf8");

describe("MAX_TREE_DEPTH", () => {
  it("matches the withdrawL1 and withdrawL2 circuit params in circuits.json", () => {
    const circuits = JSON.parse(repoFile("packages/circuits/circuits.json"));
    expect(circuits.withdrawL1.params).toEqual([MAX_TREE_DEPTH]);
    expect(circuits.withdrawL2.params).toEqual([MAX_TREE_DEPTH]);
  });

  it("matches the pool's on-chain MAX_TREE_DEPTH", () => {
    const state = repoFile("packages/contracts/src/contracts/State.sol");
    const onchain = state.match(/uint32\s+public\s+constant\s+MAX_TREE_DEPTH\s*=\s*(\d+);/);
    expect(onchain, "MAX_TREE_DEPTH not found in State.sol").not.toBeNull();
    expect(Number(onchain![1])).toBe(MAX_TREE_DEPTH);
  });

  it("matches the padding the e2e references apply before proving", () => {
    // scripts/e2e/relay.mjs is the working L1 reference the SDK is supposed to mirror.
    const relay = repoFile("packages/circuits/scripts/e2e/relay.mjs");
    for (const signal of ["stateProof.siblings", "aspProof.siblings"]) {
      expect(relay).toContain(`padSiblings(${signal}, ${MAX_TREE_DEPTH})`);
    }
  });
});
