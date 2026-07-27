/**
 * A next step for the failures that have one.
 *
 * The raw exception is kept — it is what makes a bug report useful — but on its
 * own it is a dead end for anyone who is not holding this codebase in their head.
 * Only failures with a genuinely actionable fix appear here; guessing at the rest
 * would train people to ignore the line.
 */
export const ERROR_HINTS = [
  [/invalidproof|proof.*revert|revert.*proof/i,
    "Proof verification is temporarily unavailable because this deployment is out of date. Please try again later."],
  [/fetchartifact|artifacts?\/|\.vkey|\.zkey|\.wasm/i,
    "Circuit artifacts are missing from the SDK bundle. Run `yarn circuits:copy` in packages/sdk."],
  [/nullifieralreadyspent|already been spent/i,
    "That note is already spent on chain. Run SCAN to refresh this vault."],
  [/unknownstateroot|stale/i,
    "The indexed state root is behind the chain. Run SCAN, then try again."],
  [/insufficient|balance/i,
    "Top up the connected account, or use MAX to fit the deposit to the balance."],
  [/failed to fetch|networkerror|econnrefused|configuration/i,
    "The f5 API is not reachable. Check that the server on :8787 is running."],
];

export function errorHint(message) {
  return ERROR_HINTS.find(([pattern]) => pattern.test(String(message ?? "")))?.[1] ?? "";
}
