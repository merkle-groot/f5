/**
 * Groth16 proving, off the main thread.
 *
 * snarkjs runs the witness and the proof synchronously. On the main thread that
 * means the tab stops repainting for tens of seconds — no spinner animates, no
 * timer fires, and the only honest thing the UI could do was warn in advance
 * (`provingNotice`). Here the freeze happens on a thread nobody is looking at, so
 * the page stays live and can show elapsed time, keep the notice animating, and
 * let the user read the rest of the screen while they wait.
 *
 * Deliberately stateless and one-shot: every request builds its own SDK instance.
 * A cached instance would be a second place for circuit artifacts to be stale
 * (see `copy_circuits.sh`), and the artifacts are HTTP-cached by the browser
 * anyway, so re-instantiating costs nothing that matters.
 *
 * Nothing secret leaves this worker. It receives note secrets, returns a proof,
 * and holds no reference after it posts — the same lifetime the main thread had.
 */

/** `window` does not exist here; the artifacts are served from this same origin. */
const baseUrl = `${self.location.origin}/api/circuits/`;

/** The three proving entry points, each paired with its verifier. `args` is spread
 *  because the shapes genuinely differ — the L1 and commitment circuits take
 *  (commitment, input) while the L2 one takes a single input object. */
const CIRCUITS = {
  withdrawL1: ["proveWithdrawalL1", "verifyWithdrawalL1", "L1 proof verification failed."],
  withdrawL2: ["proveWithdrawalL2", "verifyWithdrawalL2", "Destination proof verification failed."],
  commitment: ["proveCommitment", "verifyCommitment", "Ragequit proof verification failed."],
};

async function run({ kind, args }) {
  const entry = CIRCUITS[kind];
  if (!entry) throw new Error(`Unknown proving request: ${kind}`);
  const [proveFn, verifyFn, failure] = entry;

  // Loading the SDK is the one step that can fail because this is a WORKER rather
  // than because the proof is bad — a build that reaches for `window` at import
  // time would die here. Flagged separately so the caller can fall back to
  // main-thread proving instead of reporting a proof failure that never happened.
  let Circuits, PrivacyPoolSDK;
  try {
    ({ Circuits, PrivacyPoolSDK } = await import("@f5/privacy-pool-sdk"));
  } catch (error) {
    throw Object.assign(new Error(`Worker could not load the SDK: ${error?.message ?? error}`), { fallback: true });
  }
  const pool = new PrivacyPoolSDK(new Circuits({ browser: true, baseUrl }));

  const proof = await pool[proveFn](...args);
  if (!(await pool[verifyFn](proof))) throw new Error(failure);
  return proof;
}

self.addEventListener("message", async (event) => {
  const { id, payload } = event.data ?? {};
  try {
    self.postMessage({ id, ok: true, proof: await run(payload) });
  } catch (error) {
    // Error objects do not survive structured clone with their subclass intact, and
    // the SDK's useful text lives in `details` rather than `message` (see
    // `describeError`), so flatten both sides here while they are still readable.
    self.postMessage({
      id,
      ok: false,
      fallback: error?.fallback === true,
      message: error?.message ?? String(error),
      details: error?.details && typeof error.details === "object"
        ? Object.values(error.details).filter((value) => typeof value === "string")
        : [],
    });
  }
});
