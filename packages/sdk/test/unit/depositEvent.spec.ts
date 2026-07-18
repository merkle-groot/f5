import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  decodeEventLog,
  encodeEventTopics,
  encodeAbiParameters,
  parseAbiItem,
  toEventSelector,
} from "viem";

import { generateDepositSecrets, generateMasterKeys, hashPrecommitment } from "../../src/crypto.js";
import { recoverNotes } from "../../src/identity.js";
import { Hash } from "../../src/types/commitment.js";

/**
 * `Deposited` decoding guard.
 *
 * Mnemonic-based note recovery matches derived precommitments against the 5th
 * field of this event, so if the indexer decodes that field wrongly, a user's
 * notes become unrecoverable — silently, with no error anywhere.
 *
 * The indexer's copy of the ABI used to call that field `_merkleRoot`. It
 * decoded correctly only by accident: `topic0` hashes parameter TYPES, not
 * names, and the position happened to line up. Nothing tested it —
 * `data.service.spec.ts` is `skipIf(!HYPERSYNC_API_KEY)` and hits live Sepolia,
 * so it never runs. A well-meaning rename in one file and recovery breaks.
 *
 * So: pin the SDK's event ABI to the CONTRACT's declaration, and prove a real
 * encoded log round-trips into a note the mnemonic can actually recover.
 */
const here = dirname(fileURLToPath(import.meta.url));
const IPRIVACY_POOL = resolve(
  here,
  "../../../contracts/src/interfaces/IPrivacyPool.sol",
);

/** The `Deposited` event exactly as the contract declares it. */
function contractDepositedEvent(): string {
  const source = readFileSync(IPRIVACY_POOL, "utf8");
  const match = source.match(/event\s+Deposited\s*\(([\s\S]*?)\)\s*;/);
  if (!match) throw new Error("Deposited event not found in IPrivacyPool.sol");
  const params = match[1]!.split(",").map((p) => p.trim().replace(/\s+/g, " ")).join(", ");
  return `event Deposited(${params})`;
}

/**
 * The ABI the indexer actually decodes with, READ FROM `data.service.ts`.
 *
 * Not a copy pasted in here: comparing two hand-written copies of a layout is
 * precisely how the `withdrawL1` public-signal bug survived its own regression
 * test. Both sides must be read from source, or the test proves nothing.
 */
function indexerDepositedEvent(): string {
  const source = readFileSync(
    resolve(here, "../../src/core/data.service.ts"),
    "utf8",
  );
  const match = source.match(/const DEPOSIT_EVENT = parseAbiItem\(\s*'([^']+)'\s*\)/);
  if (!match) throw new Error("DEPOSIT_EVENT not found in data.service.ts");
  return match[1]!.trim().replace(/\s+/g, " ");
}
const INDEXER_EVENT = indexerDepositedEvent();

const MNEMONIC = "test test test test test test test test test test test junk";
const SCOPE = 1072257550380742535619809584692670747078661758898091403955338665663319571310n as Hash;

describe("Deposited event decoding", () => {
  const contractEvent = contractDepositedEvent();

  it("the indexer's ABI matches the contract's event declaration", () => {
    expect(INDEXER_EVENT).toBe(contractEvent);
  });

  it("names the 5th field precommitment, not a merkle root", () => {
    // The historical bug. The field carries Poseidon(nullifier, secret).
    expect(contractEvent).toContain("uint256 _precommitmentHash");
    expect(contractEvent).not.toContain("_merkleRoot");
  });

  it("agrees with the contract on topic0", () => {
    expect(toEventSelector(parseAbiItem(INDEXER_EVENT) as never)).toBe(
      toEventSelector(parseAbiItem(contractEvent) as never),
    );
  });

  it("a real encoded log decodes into a note the mnemonic recovers", () => {
    const keys = generateMasterKeys(MNEMONIC);
    const index = 3n;
    const { nullifier, secret } = generateDepositSecrets(keys, SCOPE, index);
    const precommitment = hashPrecommitment(nullifier, secret) as bigint;

    const commitment = 12345678901234567890n;
    const label = 999n;
    const value = 1_000_000n;

    // Encode a log the way the chain would.
    const abi = [parseAbiItem(INDEXER_EVENT)] as never;
    const topics = encodeEventTopics({
      abi,
      eventName: "Deposited",
      args: { _depositor: "0x0000000000000000000000000000000000000abc" },
    } as never);
    const data = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [commitment, label, value, precommitment],
    );

    const decoded = decodeEventLog({ abi, data, topics } as never) as unknown as {
      args: Record<string, bigint>;
    };

    // The field the indexer aliases to `precommitment` must be the precommitment.
    expect(decoded.args._precommitmentHash).toBe(precommitment);
    expect(decoded.args._commitment).toBe(commitment);
    expect(decoded.args._value).toBe(value);

    // And it must be enough to actually recover the note.
    const recovered = recoverNotes(MNEMONIC, SCOPE, [
      {
        commitment: decoded.args._commitment!,
        label: decoded.args._label!,
        value: decoded.args._value!,
        precommitment: decoded.args._precommitmentHash!,
      },
    ]);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.index).toBe(index);
    expect(hashPrecommitment(recovered[0]!.nullifier, recovered[0]!.secret) as bigint).toBe(
      precommitment,
    );
  });
});
