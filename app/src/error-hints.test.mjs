import assert from "node:assert/strict";
import test from "node:test";
import { errorHint } from "./error-hints.js";

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

test("an unrecognised failure gets no invented advice", () => {
  assert.equal(errorHint("Something entirely novel went wrong"), "");
  assert.equal(errorHint(""), "");
  assert.equal(errorHint(null), "");
  assert.equal(errorHint(undefined), "");
});
