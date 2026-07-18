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
