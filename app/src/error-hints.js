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
  // Not a staleness hint: the pool keeps 64 past roots and accepts any of them, so a
  // merely-behind index still spends. A rejected root is one the pool has never held,
  // which means the server's log index skipped an insertion — SCAN re-reads that same
  // index and changes nothing. `?refresh=1` is what replays the stream from scratch.
  [/unknownstateroot/i,
    "The proof was built against a tree the pool has never held, because the server's log index is missing an insertion. Reload the page with ?refresh=1 to replay it, then withdraw again. Nothing was spent."],

  // The server-side guard for the same fault, caught before a proof is generated
  // rather than after. Distinct message, so it gets its own line.
  [/does not match the pool on-chain|refusing to serve proofs/i,
    "The server caught its own log index missing an insertion and stopped before building an unusable proof. It replays automatically — wait a moment and retry. If it keeps happening the RPC endpoint is dropping logs and needs replacing."],

  // A broadcast that failed at the provider, not at the pool. Kept above the generic
  // RPC line because the reassurance is specific: the transaction was signed, so the
  // natural fear is that it half-landed and a retry will double-spend. It cannot —
  // `withdraw` marks the nullifier spent and rejects any second spend of the same
  // note, so the worst case of retrying is one clean revert.
  [/eth_sendrawtransaction/i,
    "The RPC provider failed while broadcasting, so the pool was never reached. Retry — the transaction either never landed, or it did and the pool will reject the duplicate. Neither outcome can spend the note twice."],

  // Anything else the provider fails on its own: a 5xx, or drpc's code-19 body.
  // These read like contract failures because viem prints the whole call around
  // them, so name the provider explicitly.
  [/temporary internal error|trace-id|status: 5\d\d|"code":\s*19/i,
    "The RPC provider failed, not the pool — this is an outage on their side. Retry in a moment; if it persists the endpoint is degraded and needs swapping."],

  // JSON-RPC -32002, which viem renders as "Requested resource not available".
  // Brave Wallet returns this whenever a request would need its approval prompt and
  // the requesting tab is not the visible one — a background tab, a tab behind a
  // detached window, or a page being driven by automation. It is a property of that
  // wallet, not of the pool, and the banner reads like a pool failure without this
  // line. Matched on the wallet's own detail string rather than on the -32002 code,
  // because MetaMask reuses that same code for its unrelated "already pending" case.
  [/tab is not active/i,
    "That is the wallet refusing, not the pool. Brave Wallet only opens its approval prompt for the tab you are actually looking at, so click into this page to bring it to the front and press CONNECT again. If you meant to use a different wallet, pick that one from the list instead."],

  [/insufficient|balance/i,
    "Top up the connected account, or use MAX to fit the deposit to the balance."],
  [/failed to fetch|networkerror|econnrefused|configuration/i,
    "The f5 API is not reachable. Check that the server on :8787 is running."],
];

export function errorHint(message) {
  return ERROR_HINTS.find(([pattern]) => pattern.test(String(message ?? "")))?.[1] ?? "";
}

/**
 * Human-readable failure text.
 *
 * SDKError wraps the real cause: `throw ProofError.generationFailed({ error: <the actual message> })`
 * — so `error.message` is only ever the generic wrapper ("Failed to generate proof") and the useful
 * part sits in `details`. Reading just `.message` makes every SDK failure look identical and
 * undebuggable, so unwrap `details` here.
 *
 * The non-Error branch is not defensive padding. EIP-1193 says a provider rejects with an
 * object carrying `code` and `message`, and it never requires that object to be an Error —
 * Brave Wallet's rejections are plain objects, and wagmi's injected connector rethrows the
 * -32002 one verbatim rather than wrapping it in viem's `ResourceUnavailableRpcError`. So
 * `String(error)` produced "[object Object]": no message on screen, nothing in the banner's
 * `title` for a bug report, and no text for `errorHint` to match, which silently disabled
 * the hint line for exactly the failures that most need one.
 */
export function describeError(error) {
  if (!(error instanceof Error)) {
    const message = error && typeof error === "object" ? error.message : null;
    if (typeof message !== "string" || !message) return String(error);
    // The numeric code is kept because it, not the prose, is what identifies the failure
    // across wallets — the same -32002 carries a different sentence in every extension.
    return typeof error.code === "number" ? `${message} (code ${error.code})` : message;
  }
  const details = error.details;
  if (details && typeof details === "object") {
    const inner = Object.values(details).filter((v) => typeof v === "string" && v && v !== error.message);
    if (inner.length) return `${error.message}: ${inner.join(" · ")}`;
  }
  return error.message;
}

/**
 * Elide the long hex runs viem prints, so the diagnosis stays on screen.
 *
 * A failed `writeContract` prints the signed transaction, the calldata and every
 * proof element in full: several kilobytes of hex wrapped around the one line that
 * says what happened, which viem puts LAST under `Details:`. Off the bottom of the
 * banner, in practice.
 *
 * The threshold is 64 hex characters, not 40, so that a 20-byte address survives
 * intact — addresses are the part of that dump a reader can actually act on, while
 * a 32-byte field element is not something anyone eyeballs. The length is reported
 * rather than dropped silently, and `errorView` keeps the untouched string in the
 * element's `title`, so nothing is destroyed.
 */
export function condenseError(message) {
  return String(message ?? "")
    .replace(
      /0x[0-9a-fA-F]{64,}/g,
      (hex) => `${hex.slice(0, 10)}…${hex.slice(-4)} [${hex.length - 2} hex]`,
    )
    // viem prints the failing RPC URL, and for a keyed provider the API key IS the
    // last path segment — so an unedited error banner publishes a live credential to
    // whoever is looking at the screen, and again to whoever a screenshot reaches.
    // The host is the diagnostically useful part and is kept.
    .replace(
      /(https?:\/\/[^\s/]+(?:\/[\w-]+)*?)\/[A-Za-z0-9_-]{20,}/g,
      (_full, prefix) => `${prefix}/<redacted>`,
    );
}
