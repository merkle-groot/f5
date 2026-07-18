import { describe, it, expect } from "vitest";
import { decodeEventLog, encodeAbiParameters, encodeEventTopics, parseAbiItem } from "viem";
import { poseidon } from "maci-crypto/build/ts/hashing.js";
import { LeanIMT } from "@zk-kit/lean-imt";

import { DataService } from "../../src/core/data.service.js";
import { Hash } from "../../src/types/commitment.js";

/**
 * Offline coverage for the indexer.
 *
 * `data.service.spec.ts` is `describe.skipIf(!HYPERSYNC_API_KEY)` and points at a
 * pool that is no longer deployed, so it has never run — which is how a broken
 * `Withdrawn` ABI and a misnamed deposit field both shipped. These tests need no
 * network: the log-decoding path is exercised with logs we encode ourselves, and
 * the scan/tree helpers are pure.
 */
const service = new DataService([
  {
    chainId: 11155111,
    privacyPoolAddress: "0x0000000000000000000000000000000000000001",
    startBlock: 0n,
    rpcUrl: "http://127.0.0.1:0", // never dialled: nothing here touches the network
  },
]);

const hash = (v: bigint) => v as Hash;

describe("Withdrawn log decoding", () => {
  const event = parseAbiItem(
    "event Withdrawn(uint256 _newCommitmentHashL1, uint256 _newComitmentHashL2, uint256 _value, uint256 _spentNullifier)",
  );

  it("reads the L1 change note as `newCommitment`, not C_dest", () => {
    const changeNote = 111n;
    const cDest = 222n;
    const value = 5_000n;
    const spent = 333n;

    const abi = [event] as never;
    const decoded = decodeEventLog({
      abi,
      topics: encodeEventTopics({ abi, eventName: "Withdrawn" } as never),
      data: encodeAbiParameters(
        [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
        [changeNote, cDest, value, spent],
      ),
    } as never) as unknown as { args: Record<string, bigint> };

    // The L1 tree inserts the CHANGE note. C_dest is bridged, never inserted on
    // L1 — mixing them up corrupts every subsequent merkle proof.
    expect(decoded.args._newCommitmentHashL1).toBe(changeNote);
    expect(decoded.args._newComitmentHashL2).toBe(cDest);
    expect(decoded.args._value).toBe(value);
    expect(decoded.args._spentNullifier).toBe(spent);
  });
});

describe("buildScannableNotes", () => {
  const note = (commitment: bigint, viewTag: string) => ({
    commitment: hash(commitment),
    ephemeralKey: [commitment * 2n, commitment * 3n] as readonly [bigint, bigint],
    viewTag,
    blockNumber: 1n,
    transactionHash: "0x00" as const,
  });

  it("joins the L1 delivery with the L2 arrival to recover the cleartext value", () => {
    // C_dest folds `value` in, so a scanner CANNOT confirm a note without it —
    // and the value only exists on the L2 `NoteReceived` event.
    const candidates = service.buildScannableNotes(
      [note(10n, "0x07"), note(20n, "0x1f")] as never,
      [
        { commitment: hash(10n), value: 1_000n },
        { commitment: hash(20n), value: 2_000n },
      ] as never,
    );

    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => [c.commitment, c.value, c.viewTag])).toEqual([
      [10n, 1_000n, "0x07"],
      [20n, 2_000n, "0x1f"],
    ]);
    expect(candidates[0]!.ephemeralKey).toEqual([20n, 30n]);
  });

  it("drops a note whose tokens have not landed yet", () => {
    // Delivered on L1, not yet received on L2: there is no value, so it is not
    // yet scannable. It reappears once the bridge settles.
    const candidates = service.buildScannableNotes(
      [note(10n, "0x07"), note(99n, "0xaa")] as never,
      [{ commitment: hash(10n), value: 1_000n }] as never,
    );
    expect(candidates.map((c) => c.commitment)).toEqual([10n]);
  });

  it("is empty when nothing has arrived", () => {
    expect(service.buildScannableNotes([note(10n, "0x07")] as never, [])).toEqual([]);
  });
});

describe("reconstructL2StateTree", () => {
  const activated = (commitments: bigint[]) =>
    commitments.map((commitment) => ({ commitment: hash(commitment), value: 1n })) as never;

  it("reproduces the pool's tree, so membership proofs verify", () => {
    const leaves = [7n, 8n, 9n, 10n];
    const tree = service.reconstructL2StateTree(activated(leaves));

    const expected = new LeanIMT<bigint>((a, b) => poseidon([a, b]));
    expected.insertMany(leaves);

    expect(tree.root).toBe(expected.root);
    expect(tree.depth).toBe(expected.depth);

    const index = tree.indexOf(9n);
    expect(index).toBe(2);
    const proof = tree.generateProof(index);
    expect(proof.root).toBe(expected.root);
  });

  it("is order-sensitive — activation order IS the leaf order", () => {
    // The pool inserts on activation, so replaying events out of order yields a
    // different root and every proof built against it is rejected on-chain.
    expect(service.reconstructL2StateTree(activated([1n, 2n, 3n])).root).not.toBe(
      service.reconstructL2StateTree(activated([3n, 2n, 1n])).root,
    );
  });

  it("an unactivated commitment is absent from the tree", () => {
    const tree = service.reconstructL2StateTree(activated([1n, 2n]));
    expect(tree.indexOf(42n)).toBe(-1);
  });
});
