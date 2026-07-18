#!/usr/bin/env bash
# Stage circuit artifacts where the SDK actually reads them.
#
# The SDK's Circuits class fetches "<baseUrl>artifacts/<name>.{wasm,vkey,zkey}", and the app server
# serves /api/circuits/artifacts from the SDK's dist:
#   app/server/index.mjs -> node_modules/@0xbow/privacy-pools-core-sdk/dist/node/artifacts/
#   ( that package is a symlink to packages/sdk, so the real path is the DEST below )
# Without this staging every artifact 404s and nothing can prove.
#
# `downloadArtifacts` fetches commitment + withdrawL1 + withdrawL2 EAGERLY (Promise.all), so all
# nine files must exist even though the Vault only ever uses withdrawL1/withdrawL2.
#
# SOURCE OF TRUTH: build/<circuit>/groth16_pkey.zkey — the same key scripts/gen-verifier.sh reads
# to emit the Solidity verifier. Staging any other key produces proofs the deployed verifier
# rejects. `setup` is randomised: re-running it changes `delta` and invalidates every verifier
# generated from the previous key. If you re-run setup, re-run gen-verifier.sh AND redeploy the
# affected verifier/pool, then re-run this script.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/.."

DEST="../sdk/dist/node/artifacts"
mkdir -p "$DEST"

stage_built() { # <circuit> <artifact-name>
  local circuit="$1" name="$2"
  cp "build/${circuit}/${circuit}_js/${circuit}.wasm" "${DEST}/${name}.wasm"
  cp "build/${circuit}/groth16_pkey.zkey" "${DEST}/${name}.zkey"
  cp "build/${circuit}/groth16_vkey.json" "${DEST}/${name}.vkey"
  echo "  ${name}: build/${circuit}"
}

echo "staging -> ${DEST}"
stage_built withdrawL1 withdrawL1
stage_built withdrawL2 withdrawL2

# commitment (ragequit) is the odd one out: build/commitmentL1 has no groth16 setup, and the
# zkey/vkey that DO match the deployed CommitmentVerifier live in trusted-setup (nPublic=4).
cp trusted-setup/final-keys/commitment.zkey "${DEST}/commitment.zkey"
cp trusted-setup/final-keys/commitment.vkey "${DEST}/commitment.vkey"
# ...but no wasm exists for that circuit. commitmentL1 is a DIFFERENT circuit (2 public inputs, not
# 4), so this wasm does NOT pair with the key above. It is staged only because the SDK refuses to
# initialise while any artifact 404s. Consequence: ragequit proving (proveCommitment) is broken;
# deposit / send / withdraw are unaffected because they never touch this circuit. Fix properly by
# either recovering the original commitment circuit's wasm or making the SDK load lazily.
cp build/commitmentL1/commitmentL1_js/commitmentL1.wasm "${DEST}/commitment.wasm"
echo "  commitment: trusted-setup keys + commitmentL1 wasm (MISMATCHED wasm — ragequit only)"

echo
echo "staged $(ls -1 "${DEST}" | wc -l | tr -d ' ') files:"
ls -1 "${DEST}" | sed 's/^/  /'
