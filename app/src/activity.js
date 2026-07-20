/**
 * The vault's activity log, derived rather than stored.
 *
 * Every event here is already recorded somewhere — an L1 note carries its deposit
 * and spend annotations, the L2 history carries withdrawals — but nothing ever
 * joined them into one chronological view, so a user could see current balances
 * and never see what the vault had actually done.
 *
 * Deliberately derived from the existing caches instead of an append-only log:
 * a separate log would be a second source of truth that could disagree with the
 * notes, and disagreeing with the notes is how a UI shows a balance nobody has.
 */

/** Newest first. Entries with no timestamp are older than any timestamped one. */
function byNewest(a, b) {
  if (a.at === b.at) return 0;
  if (a.at === null) return 1;
  if (b.at === null) return -1;
  return b.at - a.at;
}

/**
 * Flatten notes and L2 withdrawal history into one ordered list.
 *
 * `chainLabel` resolves a route key to a display name; it is injected so this
 * stays free of app state.
 */
export function buildActivity(notes = [], withdrawn = {}, chainLabel = (key) => key) {
  const entries = [];

  for (const note of notes) {
    // A recovered or legacy note has no local deposit annotation. It is still a
    // real deposit and must appear — undated rather than omitted.
    entries.push({
      kind: "deposit",
      at: note.depositedAt ?? null,
      value: note.value,
      chain: "l1",
      hash: note.depositHash ?? null,
      title: "DEPOSIT",
      detail: note.legacy ? "legacy note" : `note #${note.index}`,
    });

    if (note.status !== "spent") continue;

    if (note.spentBy === "ragequit") {
      entries.push({
        kind: "ragequit",
        at: note.spentAt ?? null,
        value: note.value,
        chain: "l1",
        hash: note.ragequitHash ?? null,
        title: "PUBLIC RAGEQUIT",
        detail: "exited publicly to the depositor",
      });
      continue;
    }

    entries.push({
      kind: "bridge",
      at: note.spentAt ?? null,
      value: note.value,
      chain: "l1",
      hash: note.spentHash ?? null,
      title: "BRIDGE",
      detail: note.spentTo ? `to ${chainLabel(note.spentTo)}` : "bridged to a destination",
    });
  }

  for (const [cDest, record] of Object.entries(withdrawn ?? {})) {
    entries.push({
      kind: "withdraw",
      at: record.at ?? null,
      value: record.value,
      chain: record.chain,
      hash: record.hash ?? null,
      title: "WITHDRAW",
      detail: record.recipient
        ? `${chainLabel(record.chain)} → ${record.recipient}`
        : `released on ${chainLabel(record.chain)}`,
      id: cDest,
    });
  }

  return entries.sort(byNewest);
}

/** Compact relative age for a log row, or "" when the event predates any timestamp. */
export function relativeTime(at, now = Date.now()) {
  if (!at) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
