#!/usr/bin/env bash
# Deploy the Starknet destination pool (verifier + StarknetPrivacyPool) to any Starknet network.
# Reusable across networks via env vars, mirroring packages/contracts/script/DeployL2.s.sol.
#
# Required env:
#   SN_ACCOUNT            sncast account name (import once: `sncast account import ...`)
#   SN_RPC               Starknet RPC URL
#   L1_POOL_ADDRESS      L1 pool address as a felt (the l1_handler `from_address`; placeholder ok
#                        pre-Stage-3, set the real L1 pool before the end-to-end run)
#   SN_ASSET_ADDRESS     L2 ERC20 the pool holds (StarkGate-bridged token) as a felt
#   SN_TOKEN_BRIDGE_ADDRESS StarkGate L2 token bridge authorized to invoke `on_receive`
# Optional env:
#   SN_MAX_RELAY_FEE_BPS max relay fee bps (default 100)
#   SN_VERIFY_FIXTURE    if set to 1, also runs an on-chain groth16 verify with the spike fixture
#
# Writes deployments/starknet-<chainId>.json.
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/.."
cd "$ROOT"

# Load ./.env so the deploy inputs live in a file instead of ad-hoc exports (see .env.example).
# An already-exported variable WINS, so `SN_RPC=... ./deploy/deploy-starknet.sh` still works for
# one-off overrides without editing the file.
if [ -f .env ]; then
  while IFS= read -r _line || [ -n "$_line" ]; do
    case "$_line" in '' | \#*) continue ;; esac
    _key=${_line%%=*}
    [ -n "${!_key:-}" ] || export "$_key=${_line#*=}"
  done < .env
  unset _line _key
fi

: "${SN_ACCOUNT:?set SN_ACCOUNT}"
: "${SN_RPC:?set SN_RPC}"
: "${L1_POOL_ADDRESS:?set L1_POOL_ADDRESS (felt)}"
: "${SN_ASSET_ADDRESS:?set SN_ASSET_ADDRESS (L2 ERC20 felt)}"
: "${SN_TOKEN_BRIDGE_ADDRESS:?set SN_TOKEN_BRIDGE_ADDRESS (StarkGate L2 token bridge felt)}"
MAX_BPS="${SN_MAX_RELAY_FEE_BPS:-100}"

# `--json` is a GLOBAL sncast flag (it must precede the subcommand); passing it after
# `declare`/`deploy` fails with "unexpected argument '--json' found" on sncast >= 0.5x.
SNCAST=(sncast --json --account "$SN_ACCOUNT")
jqf() { python3 -c "import json,sys;print([json.loads(l)[sys.argv[1]] for l in sys.stdin if l.strip().startswith('{') and sys.argv[1] in l][-1])" "$1"; }

# Is this class hash already on-chain? Exit 0 = declared, 1 = not, 2 = could not tell.
class_is_declared() {
  python3 - "$SN_RPC" "$1" <<'PY'
import json, sys, urllib.request
rpc, class_hash = sys.argv[1], sys.argv[2]
body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "starknet_getClass",
                   "params": {"block_id": "latest", "class_hash": class_hash}}).encode()
try:
    reply = json.load(urllib.request.urlopen(
        urllib.request.Request(rpc, body, {"Content-Type": "application/json"}), timeout=30))
except Exception:
    sys.exit(2)
sys.exit(0 if "result" in reply else 1)
PY
}

# Declare a contract and echo its class hash.
#
# A class hash is derived from the contract's CONTENT, so whenever the Cairo is unchanged the class
# is already on-chain from an earlier run and Starknet rejects a re-declare ("is already declared").
# That is not a failure: on a redeploy the job is to deploy a fresh INSTANCE (new constructor args,
# e.g. a different l1_pool) against the existing class. So compute the hash locally (authoritative,
# content-derived), skip the declare when the class already exists, and only declare when it does
# not. Skipping also dodges flaky public-RPC declare paths, which is why we check rather than
# "try and catch the error".
declare_class() {
  local _name="$1" _hash _out
  _hash=$("${SNCAST[@]}" utils class-hash --contract-name "$_name" | jqf class_hash)

  if class_is_declared "$_hash"; then
    echo "   $_name: class already declared, reusing $_hash" >&2
    printf '%s' "$_hash"
    return 0
  fi

  echo "   $_name: declaring $_hash" >&2
  _out=$("${SNCAST[@]}" declare --url "$SN_RPC" --contract-name "$_name" 2>&1 || true)
  if printf '%s' "$_out" | grep -q '"error"' && ! printf '%s' "$_out" | grep -qi 'already declared'; then
    echo "declare failed for $_name:" >&2
    printf '%s\n' "$_out" >&2
    exit 1
  fi
  printf '%s' "$_hash"
}

echo "== scarb build =="
scarb build >/dev/null

echo "== declare + deploy verifier =="
V_CLASS=$(declare_class Groth16VerifierBN254)
V_ADDR=$("${SNCAST[@]}" deploy --url "$SN_RPC" --class-hash "$V_CLASS" | jqf contract_address)
echo "   verifier class=$V_CLASS addr=$V_ADDR"

echo "== declare + deploy pool =="
# ctor: (l1_pool, asset, token_bridge, withdrawal_verifier, max_relay_fee_bps: u256[low,high])
P_CLASS=$(declare_class StarknetPrivacyPool)
P_ADDR=$("${SNCAST[@]}" deploy --url "$SN_RPC" --class-hash "$P_CLASS" \
  --constructor-calldata "$L1_POOL_ADDRESS" "$SN_ASSET_ADDRESS" "$SN_TOKEN_BRIDGE_ADDRESS" "$V_ADDR" "$MAX_BPS" 0 | jqf contract_address)
echo "   pool class=$P_CLASS addr=$P_ADDR"

CHAIN_ID=$(python3 -c "import urllib.request,json;print(json.load(urllib.request.urlopen(urllib.request.Request('$SN_RPC',json.dumps({'jsonrpc':'2.0','id':1,'method':'starknet_chainId','params':[]}).encode(),{'Content-Type':'application/json'})))['result'])")
SCOPE=$("${SNCAST[@]}" call --url "$SN_RPC" --contract-address "$P_ADDR" --function scope | jqf response 2>/dev/null || echo "")

mkdir -p deployments
OUT="deployments/starknet-${CHAIN_ID}.json"
python3 - "$OUT" "$CHAIN_ID" "$V_ADDR" "$P_ADDR" "$SN_ASSET_ADDRESS" "$SN_TOKEN_BRIDGE_ADDRESS" "$L1_POOL_ADDRESS" "$V_CLASS" "$P_CLASS" <<'PY'
import json,sys
out,chain,v,p,asset,token_bridge,l1,vc,pc=sys.argv[1:10]
json.dump({"chainId":chain,"contracts":[
 {"name":"Groth16VerifierBN254","address":v,"classHash":vc},
 {"name":"StarknetPrivacyPool","address":p,"classHash":pc,"asset":asset,"tokenBridge":token_bridge,"l1Pool":l1},
]}, open(out,"w"), indent=2)
print("wrote",out)
PY

if [ "${SN_VERIFY_FIXTURE:-0}" = "1" ]; then
  echo "== on-chain groth16 verify (view call, free) =="
  CALLDATA=$(python3 -c "import re;print(' '.join(re.findall(r'-?\d+', open('$ROOT/spike/fixtures/calldata_array.txt').read())))")
  "${SNCAST[@]}" call --url "$SN_RPC" --contract-address "$V_ADDR" \
    --function verify_groth16_proof_bn254 --calldata $CALLDATA
fi

echo
echo "DEPLOYED verifier=$V_ADDR pool=$P_ADDR (l2PoolFelt for L1 setBridgeConfig)"
