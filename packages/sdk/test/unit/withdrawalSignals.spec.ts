import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  WITHDRAW_L1_SIGNALS,
  WITHDRAW_L2_SIGNALS,
} from "../../src/types/withdrawal.js";

/**
 * Public-signal layout guard.
 *
 * The layout is decided by circom, not by us: it numbers public signals in the
 * TEMPLATE's signal DECLARATION order (outputs first, then inputs) and ignores
 * the order written in `component main {public [...]}`. Every hand-maintained
 * copy of that layout — the SDK's index map and the Solidity `ProofLib`
 * accessors — is a guess that can drift from the circuit.
 *
 * It did drift. `withdrawL1.circom` declares `bridgedValue` second, so it lives
 * at index 4, but both copies placed it at 9 (following the `main` list) and so
 * read `stateRoot`/`context` one slot too early. Every `relay()` reverted with
 * `ContextMismatch`. The previous version of this test compared the two
 * hand-written copies against EACH OTHER, so they agreed, and it passed while
 * the relay was totally broken.
 *
 * So: anchor everything to the circuit instead. This reconciles four
 * independently-produced sources, and any two disagreeing fails the build:
 *
 *   1. the generated verifier  — `uint[N] _pubSignals`, emitted by snarkjs from
 *      the proving key, so it is authoritative for the signal COUNT;
 *   2. the circuit `.sym`      — authoritative for the signal ORDER (names);
 *   3. `ProofLib.sol`          — hand-written accessor indices;
 *   4. `WITHDRAW_*_SIGNALS`    — hand-written TypeScript index map.
 *
 * A circuit change that reorders or adds a signal now breaks this test rather
 * than silently bricking withdrawals on-chain.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repo = (p: string) => resolve(here, "../../../", p);

const CIRCUITS = {
  l1: repo("circuits/build/withdrawL1/withdrawL1.sym"),
  l2: repo("circuits/build/withdrawL2/withdrawL2.sym"),
};
const PROOF_LIBS = {
  l1: repo("contracts/src/contracts/lib/ProofLib.sol"),
  l2: repo("contracts/src/contracts/lib/L2ProofLib.sol"),
};
const VERIFIERS = {
  l1: repo("contracts/src/contracts/verifiers/WithdrawalVerifier.sol"),
  l2: repo("contracts/src/contracts/verifiers/L2WithdrawalVerifier.sol"),
};

/**
 * The public signals of a circom witness are the entries at witness indices
 * 1..nPublic (index 0 is the constant `one`), laid out outputs-then-inputs.
 * `.sym` lines are `labelIdx,witnessIdx,componentIdx,name`.
 */
function circuitSignalOrder(symPath: string, nPublic: number): string[] {
  const byWitnessIndex = new Map<number, string>();
  for (const line of readFileSync(symPath, "utf8").split("\n")) {
    const [, witnessIndex, , name] = line.split(",");
    if (!name) continue;
    const w = Number(witnessIndex);
    if (w >= 1 && w <= nPublic && !byWitnessIndex.has(w)) {
      byWitnessIndex.set(w, name.trim().replace(/^main\./, ""));
    }
  }
  return Array.from({ length: nPublic }, (_, i) => {
    const name = byWitnessIndex.get(i + 1);
    if (!name) throw new Error(`${symPath}: no signal at witness index ${i + 1}`);
    return name;
  });
}

/** `nPublic` as snarkjs baked it into the generated verifier. */
function verifierPublicInputCount(verifierPath: string): number {
  const m = readFileSync(verifierPath, "utf8").match(
    /uint\[(\d+)\] calldata _pubSignals/,
  );
  if (!m) throw new Error(`${verifierPath}: no _pubSignals array found`);
  return Number(m[1]);
}

/** The index a named Solidity accessor reads out of `pubSignals`. */
function solidityIndexFor(source: string, accessor: string): number {
  const m = source.match(
    new RegExp(
      `function\\s+${accessor}\\s*\\([^)]*\\)[^{]*\\{[^}]*pubSignals\\[(\\d+)\\]`,
    ),
  );
  if (!m) throw new Error(`accessor ${accessor}() not found`);
  return Number(m[1]);
}

describe("withdrawL1 public-signal layout", () => {
  const nPublic = verifierPublicInputCount(VERIFIERS.l1);
  const order = circuitSignalOrder(CIRCUITS.l1, nPublic);
  const proofLib = readFileSync(PROOF_LIBS.l1, "utf8");

  /** SDK map key -> circuit signal name. */
  const sdkToCircuit: Record<keyof typeof WITHDRAW_L1_SIGNALS, string> = {
    newCommitmentHashL1: "newCommitmentHashL1",
    newCommitmentHashL2: "newCommitmentHashL2",
    existingNullifierHash: "existingNullifierHash",
    withdrawnValue: "withdrawnValue",
    bridgedValue: "bridgedValue",
    stateRoot: "stateRoot",
    stateTreeDepth: "stateTreeDepth",
    aspRoot: "ASPRoot",
    aspTreeDepth: "ASPTreeDepth",
    context: "context",
  };

  it("the SDK map covers every public signal the verifier expects", () => {
    expect(Object.keys(WITHDRAW_L1_SIGNALS)).toHaveLength(nPublic);
    expect(new Set(order)).toEqual(new Set(Object.values(sdkToCircuit)));
  });

  it("pins bridgedValue at [4] — declaration order, NOT `main {public[...]}` order", () => {
    // The regression itself. `main` lists bridgedValue last; the template
    // declares it second. The template wins.
    expect(order[4]).toBe("bridgedValue");
    expect(order[9]).toBe("context");
  });

  it.each(Object.entries(sdkToCircuit))(
    "SDK index for %s matches the circuit",
    (sdkKey, circuitName) => {
      const index = WITHDRAW_L1_SIGNALS[sdkKey as keyof typeof WITHDRAW_L1_SIGNALS];
      expect(order[index]).toBe(circuitName);
    },
  );

  it.each(Object.values(sdkToCircuit))(
    "ProofLib.sol accessor %s() reads the index the circuit assigned",
    (circuitName) => {
      expect(solidityIndexFor(proofLib, circuitName)).toBe(
        order.indexOf(circuitName),
      );
    },
  );
});

describe("withdrawL2 public-signal layout", () => {
  const nPublic = verifierPublicInputCount(VERIFIERS.l2);
  const order = circuitSignalOrder(CIRCUITS.l2, nPublic);
  const proofLib = readFileSync(PROOF_LIBS.l2, "utf8");

  const sdkToCircuit: Record<keyof typeof WITHDRAW_L2_SIGNALS, string> = {
    existingNullifierHash: "existingNullifierHash",
    noteValue: "noteValue",
    stateRoot: "stateRoot",
    stateTreeDepth: "stateTreeDepth",
    context: "context",
  };

  /** L2ProofLib names two accessors differently from their circuit signals. */
  const circuitToSolidity: Record<string, string> = {
    existingNullifierHash: "nullifierHash",
    noteValue: "withdrawnValue",
    stateRoot: "stateRoot",
    stateTreeDepth: "stateTreeDepth",
    context: "context",
  };

  it("the SDK map covers every public signal the verifier expects", () => {
    expect(Object.keys(WITHDRAW_L2_SIGNALS)).toHaveLength(nPublic);
    expect(new Set(order)).toEqual(new Set(Object.values(sdkToCircuit)));
  });

  it.each(Object.entries(sdkToCircuit))(
    "SDK index for %s matches the circuit",
    (sdkKey, circuitName) => {
      const index = WITHDRAW_L2_SIGNALS[sdkKey as keyof typeof WITHDRAW_L2_SIGNALS];
      expect(order[index]).toBe(circuitName);
    },
  );

  it.each(Object.entries(circuitToSolidity))(
    "L2ProofLib.sol accessor for %s reads the index the circuit assigned",
    (circuitName, accessor) => {
      expect(solidityIndexFor(proofLib, accessor)).toBe(
        order.indexOf(circuitName),
      );
    },
  );
});
