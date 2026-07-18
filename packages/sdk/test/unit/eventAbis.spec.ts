import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseAbiItem, toEventSelector } from "viem";

/**
 * Indexer ABI parity guard.
 *
 * `DataService` filters logs by `topic0`, which is derived from an event's name
 * and parameter TYPES. When its hand-written ABI drifts from the contract, one
 * of two things happens, and both are silent:
 *
 *   - types still match, names don't → logs decode into the WRONG FIELDS
 *     (the `_merkleRoot`/`_precommitmentHash` bug: recovery matched on a field
 *     that was correct only by accident);
 *   - types differ → `topic0` differs → `getLogs` matches NOTHING and the getter
 *     returns an empty array forever
 *     (the `Withdrawn` bug: the ABI still had the pre-Mode-3 `address indexed
 *     _processooor` shape, so `getWithdrawals()` always returned `[]` and
 *     `AccountService` treated spent notes as unspent).
 *
 * Neither raises an error. Neither was caught, because `data.service.spec.ts` is
 * `skipIf(!HYPERSYNC_API_KEY)` and hits live Sepolia, so it has never run.
 *
 * Both sides here are READ FROM SOURCE — the contract interface and the
 * indexer's own `parseAbiItem` strings. Comparing two hand-written copies of a
 * layout is exactly how the `withdrawL1` signal-order bug survived its own
 * regression test; it proves only that someone typo'd consistently.
 */
const here = dirname(fileURLToPath(import.meta.url));
const DATA_SERVICE = resolve(here, "../../src/core/data.service.ts");
const IPRIVACY_POOL = resolve(
  here,
  "../../../contracts/src/interfaces/IPrivacyPool.sol",
);

/** Normalise whitespace so multi-line Solidity declarations compare cleanly. */
const flatten = (s: string) => s.trim().replace(/\s+/g, " ");

/** An event exactly as the Solidity interface declares it. */
function contractEvent(name: string): string {
  const source = readFileSync(IPRIVACY_POOL, "utf8");
  const match = source.match(new RegExp(`event\\s+${name}\\s*\\(([\\s\\S]*?)\\)\\s*;`));
  if (!match) throw new Error(`event ${name} not found in IPrivacyPool.sol`);
  const params = match[1]!
    .split(",")
    .map((p) => flatten(p))
    .join(", ");
  return `event ${name}(${params})`;
}

/** The ABI string the indexer actually decodes with. */
function indexerEvent(constName: string): string {
  const source = readFileSync(DATA_SERVICE, "utf8");
  const match = source.match(
    new RegExp(`const ${constName} = parseAbiItem\\(\\s*'([^']+)'\\s*\\)`),
  );
  if (!match) throw new Error(`${constName} not found in data.service.ts`);
  return flatten(match[1]!);
}

const EVENTS: Array<{ constName: string; eventName: string }> = [
  { constName: "DEPOSIT_EVENT", eventName: "Deposited" },
  { constName: "WITHDRAWAL_EVENT", eventName: "Withdrawn" },
  { constName: "RAGEQUIT_EVENT", eventName: "Ragequit" },
];

describe.each(EVENTS)("indexer ABI parity: $eventName", ({ constName, eventName }) => {
  const fromContract = contractEvent(eventName);
  const fromIndexer = indexerEvent(constName);

  it("declares the same parameters, in the same order, with the same names", () => {
    // Names matter as much as types: viem keys decoded args BY NAME, so a
    // correct signature with a wrong name silently reads the wrong field.
    expect(fromIndexer).toBe(fromContract);
  });

  it("hashes to the same topic0, so getLogs actually matches", () => {
    expect(toEventSelector(parseAbiItem(fromIndexer) as never)).toBe(
      toEventSelector(parseAbiItem(fromContract) as never),
    );
  });
});

describe("the two failure modes this guard exists to catch", () => {
  it("a type change breaks topic0 (getLogs would match nothing)", () => {
    const real = parseAbiItem(contractEvent("Withdrawn")) as never;
    const stale = parseAbiItem(
      "event Withdrawn(address indexed _processooor, uint256 _value, uint256 _spentNullifier, uint256 _newCommitment)",
    ) as never;
    expect(toEventSelector(stale)).not.toBe(toEventSelector(real));
  });

  it("a name-only change keeps topic0 identical (so topic0 parity is NOT enough)", () => {
    // This is why the `_merkleRoot` misnomer survived: the signature was fine.
    const real = parseAbiItem(contractEvent("Deposited")) as never;
    const misnamed = parseAbiItem(
      "event Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _merkleRoot)",
    ) as never;
    expect(toEventSelector(misnamed)).toBe(toEventSelector(real));
  });
});
