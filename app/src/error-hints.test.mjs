import assert from "node:assert/strict";
import test from "node:test";
import { condenseError, describeError, errorHint } from "./error-hints.js";

test("a verifier mismatch gives users a clear next step without operator commands", () => {
  // The exact shape the relayer surfaces: viem wraps the revert reason.
  const hint = errorHint('The contract function "relay" reverted. Error: InvalidProof()');
  assert.match(hint, /temporarily unavailable/i);
  assert.match(hint, /try again later/i);
  assert.doesNotMatch(hint, /yarn|vkey|redeploy/i);
});

test("a missing circuit artifact points at the copy script", () => {
  const hint = errorHint("There was an error initializing the circuits: FetchArtifact: "
    + "Encountered error while loading artifact at http://localhost:5173/api/circuits/artifacts/commitment.vkey");
  assert.match(hint, /circuits:copy/);
});

test("a spent note points at SCAN", () => {
  assert.match(errorHint("That note has already been spent. Run SCAN to refresh your notes."), /SCAN/);
});

test("an unreachable API is named as such", () => {
  assert.match(errorHint("Failed to fetch"), /API is not reachable/);
});

// Both strings below are the real ones from 2026-07-28, trimmed only where noted.
// The provider dropped a NoteActivated log, then failed a broadcast; each read like a
// contract fault and neither had a hint.

test("a root the pool never held is named as an index gap, not staleness", () => {
  const hint = errorHint('The contract function "withdraw" reverted. Error: UnknownStateRoot()');
  assert.match(hint, /never held/i);
  assert.match(hint, /refresh=1/);
  // "Run SCAN" was the old advice and it was useless — SCAN re-reads the same index.
  assert.doesNotMatch(hint, /SCAN/);
});

test("the server-side guard firing is distinguished from the on-chain revert", () => {
  const hint = errorHint("Unable to index Mode-3 notes: Destination tree does not match "
    + "the pool on-chain; refusing to serve proofs.");
  assert.match(hint, /replays automatically/i);
  assert.doesNotMatch(hint, /refresh=1/);
});

test("a failed broadcast says a retry cannot double-spend", () => {
  const hint = errorHint("Failed to withdraw on L2: Transaction failed: HTTP request failed. "
    + 'Status: 500 URL: https://lb.drpc.live/base-sepolia/KEY Request body: {"method":'
    + '"eth_sendRawTransaction","params":["0x02f902f2…"]}');
  assert.match(hint, /RPC provider/i);
  assert.match(hint, /twice|double/i);
});

test("a provider outage is blamed on the provider, not the pool", () => {
  const hint = errorHint('Details: {"message":"Temporary internal error. Please retry, '
    + 'trace-id: f66e2e15baf1f18d4892f49e4f1e144c","code":19}');
  assert.match(hint, /not the pool/i);
});

test("a wallet refusing a background tab is blamed on the wallet, not the pool", () => {
  // The exact string viem builds for a -32002 out of Brave Wallet's provider.
  const hint = errorHint("Requested resource not available.\n\n"
    + "Details: The tab is not active\nVersion: viem@2.22.14");
  assert.match(hint, /wallet refusing, not the pool/i);
  assert.match(hint, /bring it to the front/i);
});

test("a genuine revert still beats the RPC hints to the match", () => {
  // Reverts arrive over the same transport, so a 5xx pattern must not shadow them.
  assert.match(
    errorHint('The contract function "relay" reverted. Error: InvalidProof()'),
    /temporarily unavailable/i,
  );
  assert.match(
    errorHint('The contract function "withdraw" reverted. Error: NullifierAlreadySpent()'),
    /already spent/i,
  );
});

test("an EIP-1193 rejection that is not an Error still yields its message", () => {
  // Exactly what Brave Wallet rejects with, and what wagmi's injected connector
  // rethrows unwrapped for -32002. `String(error)` on this is "[object Object]".
  const rejection = { code: -32002, message: "The tab is not active" };
  const described = describeError(rejection);
  assert.match(described, /The tab is not active/);
  assert.match(described, /-32002/);
  assert.doesNotMatch(described, /\[object Object\]/);
  // And the hint line has to fire off that text, which is the whole point of keeping it.
  assert.match(errorHint(described), /wallet refusing, not the pool/i);
});

test("describing an error keeps unwrapping SDK details and tolerates junk", () => {
  const wrapped = Object.assign(new Error("Failed to generate proof"), {
    details: { error: "witness calculation failed" },
  });
  assert.equal(describeError(wrapped), "Failed to generate proof: witness calculation failed");
  assert.equal(describeError(new Error("plain")), "plain");
  // A message-less object has nothing better to offer, so the old fallback stands.
  assert.equal(describeError({ code: -1 }), "[object Object]");
  assert.equal(describeError("just a string"), "just a string");
  assert.equal(describeError(null), "null");
});

test("condensing keeps addresses and the trailing diagnosis, drops the hex walls", () => {
  const raw = "Transaction failed: sender: 0x39A90bC870083Eba179933EDBB12B4cAfF2C0deD "
    + `data: 0x${"ab".repeat(600)} `
    + 'Details: {"message":"Temporary internal error","code":19}';
  const out = condenseError(raw);

  assert.match(out, /0x39A90bC870083Eba179933EDBB12B4cAfF2C0deD/); // 20-byte address survives
  assert.match(out, /Temporary internal error/);                   // the useful tail survives
  assert.match(out, /\[1200 hex\]/);                               // the wall is measured, not silent
  assert.ok(out.length < raw.length / 4, `condensed to ${out.length} of ${raw.length}`);
});

test("condensing strips the provider API key but keeps the host", () => {
  const out = condenseError("HTTP request failed. Status: 500 URL: "
    + "https://lb.drpc.live/base-sepolia/ArnouOtqyUxar2NZenQtkzyqnHxZgzYR8ahQwosiOHdW");

  assert.doesNotMatch(out, /ArnouOtqyUxar2NZenQtkzyqnHxZgzYR8ahQwosiOHdW/);
  assert.match(out, /lb\.drpc\.live\/base-sepolia\/<redacted>/);
});

test("condensing does not mangle a keyless URL", () => {
  // The public endpoints carry no credential; there is nothing to redact and the
  // path must survive intact or the message stops naming which chain failed.
  assert.match(condenseError("URL: https://sepolia.base.org"), /https:\/\/sepolia\.base\.org$/);
  assert.match(condenseError("URL: http://localhost:8787/api/l2/base/index"), /8787\/api\/l2\/base\/index$/);
});

test("condensing leaves short and empty messages untouched", () => {
  assert.equal(condenseError("Enter the final recipient address (0x…)"), "Enter the final recipient address (0x…)");
  assert.equal(condenseError(""), "");
  assert.equal(condenseError(null), "");
});

test("an unrecognised failure gets no invented advice", () => {
  assert.equal(errorHint("Something entirely novel went wrong"), "");
  assert.equal(errorHint(""), "");
  assert.equal(errorHint(null), "");
  assert.equal(errorHint(undefined), "");
});
