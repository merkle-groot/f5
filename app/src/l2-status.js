/**
 * Whether a scanned destination note is still spendable.
 *
 * Extracted from the render path because getting it wrong is not a display bug: the
 * answer decides which notes are offered for a withdrawal, and an over-permissive
 * answer sends the user through a minute of proving to a relay the pool rejects.
 *
 * The load-bearing fact is that **spending an L2 note never removes its leaf**. The
 * pool marks `nullifierHashes[h]` and leaves the tree alone, so a spent note keeps a
 * valid Merkle proof forever. Inclusion therefore means "this note existed", not "this
 * note is yours to spend", and any status derived from the proof list alone reports
 * every note this vault has ever received as spendable.
 */

/**
 * The chain's spent set for one destination, or `null` when the feed did not carry one.
 *
 * `null` is "unknown", NEVER "clean". An error payload or a server too old to publish
 * `spentNullifiers` has no field, and defaulting that to an empty set would silently
 * restore the exact behaviour this module replaces. Callers must decide what to do with
 * unknown; `deriveL2Status` keeps the note out of `spendable`, and the pre-withdrawal
 * check refuses to prove at all.
 *
 * Memoised per index payload: the caller runs this once per scanned note, against an
 * index that can carry every spend the pool has ever emitted.
 */
const cache = new WeakMap();

export function spentNullifierSet(index) {
  if (!index || typeof index !== "object") return null;
  const cached = cache.get(index);
  if (cached) return cached;
  if (!Array.isArray(index.spentNullifiers)) return null;
  const set = new Set(index.spentNullifiers.map(String));
  cache.set(index, set);
  return set;
}

/**
 * `"withdrawn" | "spendable" | "activate"` for one scanned note.
 *
 * Both spent checks matter and neither subsumes the other:
 *
 * - `withdrawn` is this vault's local record. It covers a withdrawal whose relay has
 *   landed but whose `Withdrawn` event the index has not caught up to yet.
 * - the nullifier set is the chain's record. It covers everything local state cannot
 *   know — a note spent on another device, before this browser's cache was cleared, or
 *   in a vault just restored from the mnemonic.
 *
 * A note whose spend-status is unknown (no `spentNullifiers` in the feed) is reported
 * as `activate` rather than `spendable`: not offered, and visibly unfinished.
 */
export function deriveL2Status({ note, index, withdrawn = {} }) {
  if (withdrawn[String(note.cDest)]) return "withdrawn";

  const spent = spentNullifierSet(index);
  if (spent?.has(String(note.nullifier))) return "withdrawn";

  const entry = (index?.proofs ?? []).find((proof) => String(proof.commitment) === String(note.cDest));
  if (!entry || Number(entry.index) < 0) return "activate";
  return spent ? "spendable" : "activate";
}
