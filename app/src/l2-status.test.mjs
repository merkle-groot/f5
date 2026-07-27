import assert from "node:assert/strict";
import test from "node:test";
import { deriveL2Status, spentNullifierSet } from "./l2-status.js";

const note = { cDest: 7n, nullifier: 42n, value: 5n };
const indexed = { proofs: [{ commitment: "7", index: 0 }], spentNullifiers: [] };

test("an activated note with nothing spent against it is spendable", () => {
  assert.equal(deriveL2Status({ note, index: indexed }), "spendable");
});

/**
 * The regression this module exists for. Spending leaves the leaf in the tree, so the
 * proof below stays valid forever; only the nullifier says the note is gone.
 */
test("an activated note whose nullifier is spent on chain is withdrawn, proof or not", () => {
  const index = { proofs: [{ commitment: "7", index: 0 }], spentNullifiers: ["42"] };
  assert.equal(deriveL2Status({ note, index }), "withdrawn");
});

test("the local record still wins when the index has not caught up to the spend", () => {
  assert.equal(
    deriveL2Status({ note, index: indexed, withdrawn: { 7: { value: "5" } } }),
    "withdrawn",
  );
});

/**
 * Fail closed. A feed with no `spentNullifiers` cannot distinguish a live note from a
 * spent one, and the old behaviour — inclusion means spendable — is exactly the bug.
 */
test("a feed that does not report spends never yields a spendable note", () => {
  for (const index of [
    { proofs: [{ commitment: "7", index: 0 }] },
    { proofs: [{ commitment: "7", index: 0 }], spentNullifiers: null },
    { proofs: [{ commitment: "7", index: 0 }], spentNullifiers: "42" },
    { error: "index unavailable", proofs: [] },
    null,
  ]) {
    assert.equal(deriveL2Status({ note, index }), "activate");
  }
});

test("a note that is not in the tree yet is awaiting activation", () => {
  assert.equal(
    deriveL2Status({ note, index: { proofs: [{ commitment: "9", index: 0 }], spentNullifiers: [] } }),
    "activate",
  );
  // index -1 is the route's "activated but not located in the tree" marker.
  assert.equal(
    deriveL2Status({ note, index: { proofs: [{ commitment: "7", index: -1 }], spentNullifiers: [] } }),
    "activate",
  );
});

test("compares nullifiers by value, not by JS type", () => {
  const index = { proofs: [{ commitment: 7n, index: 0 }], spentNullifiers: [42n] };
  assert.equal(deriveL2Status({ note: { cDest: "7", nullifier: "42" }, index }), "withdrawn");
});

test("spentNullifierSet separates unknown from empty, and memoises per payload", () => {
  assert.equal(spentNullifierSet({ proofs: [] }), null);
  assert.equal(spentNullifierSet(undefined), null);

  const index = { spentNullifiers: ["1", "2"] };
  const first = spentNullifierSet(index);
  assert.deepEqual([...first], ["1", "2"]);
  assert.equal(spentNullifierSet(index), first);

  const empty = spentNullifierSet({ spentNullifiers: [] });
  assert.notEqual(empty, null);
  assert.equal(empty.size, 0);
});
