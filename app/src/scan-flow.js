/**
 * Run scan steps strictly one at a time, in the order supplied.
 *
 * Each step owns its network work. Awaiting `step.run()` before advancing is the
 * important privacy/provider constraint: a Scan click must never fan out into a
 * burst of RPC-backed index requests.
 */
export async function runSequentialScan(steps, { onStep = async () => {} } = {}) {
  const results = [];

  for (const step of steps) {
    await onStep(step, { status: "scanning", detail: step.scanningDetail ?? "Scanning…" });
    try {
      const value = await step.run();
      const status = value?.status === "skipped" ? "skipped" : "complete";
      results.push({ step, value, status });
      await onStep(step, { status, detail: value?.detail ?? (status === "skipped" ? "Skipped" : "Complete") });
    } catch (error) {
      results.push({ step, error, status: "error" });
      await onStep(step, {
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
      });
      if (!step.continueOnError) throw error;
    }
  }

  return results;
}

/**
 * Decide which previously-known L2 notes survive a scan.
 *
 * A scan rebuilds `scanned` from whatever it fetched, so anything it did not fetch
 * would silently vanish from the balance and the rail. Two separate cases need
 * carrying over, and getting either wrong makes a user's notes disappear:
 *
 *  - a route that failed, or that a partial scan never visited, keeps its previous
 *    matches — its notes are unknown this pass, not gone;
 *  - a `pending` self-bridge survives even on a route that *did* complete, because
 *    the destination cannot see it until the bridge delivers.
 *
 * Returns the notes to append to the fresh results, in their original order.
 */
export function preservedNotes({ previous = [], fresh = [], refreshedRoutes = [] } = {}) {
  const refreshed = new Set(refreshedRoutes);
  const seen = new Set(fresh.map((note) => `${note.chain}:${note.cDest}`));
  const keep = [];

  for (const note of previous) {
    const id = `${note.chain}:${note.cDest}`;
    if (seen.has(id)) continue;
    if (note._status === "pending" || !refreshed.has(note.chain)) {
      keep.push(note);
      seen.add(id);
    }
  }

  return keep;
}
