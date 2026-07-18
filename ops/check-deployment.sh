#!/usr/bin/env bash
#
# Deployment drift checker.
#
# Treats packages/contracts/deployments/*.json and packages/starknet-pool/deployments/*.json
# (what the deploy scripts emit) as the source of truth, then answers two questions:
#
#   1. Are the deployments done?         records exist, and with --onchain, code is live
#   2. Is every consumer wired to them?  app/, relayer/, contracts/, starknet-pool/, sdk/
#
# Read-only: never writes, never sources a .env (parses it), never prints a secret.
#
# Usage:
#   ops/check-deployment.sh              # record + env drift checks (offline, fast)
#   ops/check-deployment.sh --onchain    # also verify against live chains (needs cast + RPCs)
#
# Exit: 0 = consistent, 1 = drift or missing deployment, 2 = bad usage/tooling.
#
# Note: macOS ships bash 3.2, so no associative arrays, no ${var,,}, and no lastpipe --
# every read-loop uses process substitution to stay in the current shell and keep counters.

set -uo pipefail

ONCHAIN=0
for arg in "$@"; do
  case "$arg" in
    --onchain) ONCHAIN=1 ;;
    -h|--help) sed -n '3,18p' "$0" | sed 's/^# \{0,1\}//; s/^#$//'; exit 0 ;;
    *) printf 'unknown argument: %s (try --help)\n' "$arg" >&2; exit 2 ;;
  esac
done

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd) || exit 2
cd "$REPO_ROOT" || exit 2

command -v jq >/dev/null 2>&1 || { echo "jq is required (brew install jq)" >&2; exit 2; }
if [ "$ONCHAIN" = 1 ] && ! command -v cast >/dev/null 2>&1; then
  echo "--onchain needs cast (foundryup)" >&2; exit 2
fi

if [ -t 1 ]; then
  RED=$(printf '\033[31m'); GRN=$(printf '\033[32m'); YLW=$(printf '\033[33m')
  DIM=$(printf '\033[2m');  BLD=$(printf '\033[1m');  RST=$(printf '\033[0m')
else
  RED=; GRN=; YLW=; DIM=; BLD=; RST=
fi

PASS=0; FAIL=0; WARN=0
ok()      { printf "  ${GRN}pass${RST}  %b\n" "$1"; PASS=$((PASS + 1)); }
bad()     { printf "  ${RED}FAIL${RST}  %b\n" "$1"; FAIL=$((FAIL + 1)); }
warn()    { printf "  ${YLW}warn${RST}  %b\n" "$1"; WARN=$((WARN + 1)); }
skip()    { printf "  ${DIM}skip${RST}  %b\n" "$1"; }
section() { printf "\n${BLD}%s${RST}\n" "$1"; }
note()    { printf "${DIM}%s${RST}\n" "$1"; }

# ---- normalisation -----------------------------------------------------------
# EVM addresses compare case-insensitively: records are checksummed (0xf913AB5e...)
# while app/.env holds lowercase (0xf913ab5e...). Same address, different bytes.
lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

norm_addr() { lc "$1"; }

# Felts compare with leading zeros stripped: 0x053cc08c and 0x53cc08c are one value.
norm_felt() {
  local v
  v=$(lc "$1"); v=${v#0x}
  v=$(printf '%s' "$v" | sed -E 's/^0+//')
  [ -z "$v" ] && v=0
  printf '0x%s' "$v"
}

# Redact provider API keys before anything reaches stdout.
redact() { printf '%s' "$1" | sed -E 's#(/v3/|/rpc/v[0-9_]+/|apiKey=)[A-Za-z0-9_-]+#\1<redacted>#g'; }

# ---- readers -----------------------------------------------------------------
# Parse KEY=value from a .env without sourcing it; sourcing would execute the file.
env_get() {
  local file=$1 key=$2 line val
  [ -f "$file" ] || return 1
  line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" 2>/dev/null | tail -1)
  [ -z "$line" ] && return 1
  val=${line#*=}
  val=$(printf '%s' "$val" | sed -E 's/[[:space:]]+#.*$//; s/^[[:space:]]*//; s/[[:space:]]*$//; s/^"(.*)"$/\1/; s/^'\''(.*)'\''$/\1/')
  printf '%s' "$val"
}

# Pull one field of one named contract out of a deploy record.
rec_get() {
  local file=$1 name=$2 field=$3 out
  [ -f "$file" ] || return 1
  out=$(jq -r --arg n "$name" --arg f "$field" \
    'first(.contracts[] | select(.name == $n) | .[$f]) // empty' "$file" 2>/dev/null)
  if [ -z "$out" ] || [ "$out" = null ]; then return 1; fi
  printf '%s' "$out"
}

# ---- comparators -------------------------------------------------------------
cmp_addr() {
  local label=$1 want=$2 got=$3
  if [ -z "$got" ]; then bad "$label is unset (expected $want)"; return; fi
  if [ "$(norm_addr "$want")" = "$(norm_addr "$got")" ]; then ok "$label = $got"
  else bad "$label = $got\n        expected $want"; fi
}

cmp_felt() {
  local label=$1 want=$2 got=$3
  if [ -z "$got" ]; then bad "$label is unset (expected $want)"; return; fi
  if [ "$(norm_felt "$want")" = "$(norm_felt "$got")" ]; then ok "$label = $got"
  else bad "$label = $got\n        expected $want"; fi
}

cmp_exact() {
  local label=$1 want=$2 got=$3
  if [ -z "$got" ]; then bad "$label is unset (expected $want)"; return; fi
  if [ "$want" = "$got" ]; then ok "$label = $got"
  else bad "$label = $got\n        expected $want"; fi
}

# ---- source of truth ---------------------------------------------------------
NATIVE_ASSET=0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE
L1_CHAIN_ID=11155111
L1_REC="packages/contracts/deployments/${L1_CHAIN_ID}.json"
CONTRACTS_ENV=packages/contracts/.env
APP_ENV=app/.env

# key|chainId|record|appPrefix|contractsEnvPrefix|kind
DESTINATIONS="\
op|11155420|packages/contracts/deployments/11155420.json|OP|OP_SEPOLIA|evm
base|84532|packages/contracts/deployments/84532.json|BASE|BASE_SEPOLIA|evm
starknet|0x534e5f5345504f4c4941|packages/starknet-pool/deployments/starknet-0x534e5f5345504f4c4941.json|STARKNET|STARKNET_SEPOLIA|starknet"

printf "${BLD}Cutout deployment check${RST} ${DIM}(sepolia)${RST}\n"
note "source of truth: deployments/*.json"

# =============================================================================
section "1. Deployment records"

if [ ! -f "$L1_REC" ]; then
  printf "  ${RED}FAIL${RST}  L1 record missing: %s\n" "$L1_REC"
  printf "        the L1 protocol is not deployed -- run: yarn deploy:protocol:sepolia --broadcast\n"
  printf "\n${RED}Cannot continue without the canonical L1 record.${RST}\n"
  exit 1
fi

L1_POOL=$(rec_get "$L1_REC" PrivacyPool_ETH address)
L1_SCOPE=$(rec_get "$L1_REC" PrivacyPool_ETH scope)
L1_BLOCK=$(rec_get "$L1_REC" PrivacyPool_ETH deploymentBlock)
ENTRYPOINT=$(rec_get "$L1_REC" Entrypoint_Proxy address)

if [ -z "$L1_POOL" ] || [ -z "$ENTRYPOINT" ]; then
  printf "  ${RED}FAIL${RST}  %s is malformed (need PrivacyPool_ETH + Entrypoint_Proxy)\n" "$L1_REC"
  exit 1
fi
ok "L1 pool       $L1_POOL ${DIM}(block $L1_BLOCK)${RST}"
ok "L1 entrypoint $ENTRYPOINT"

while IFS='|' read -r key chain_id record app_prefix env_prefix kind; do
  [ -n "$key" ] || continue
  if [ ! -f "$record" ]; then
    warn "$key not deployed (no $record)"
    continue
  fi
  if [ "$kind" = starknet ]; then
    addr=$(rec_get "$record" StarknetPrivacyPool address)
  else
    addr=$(rec_get "$record" L2PrivacyPool address)
  fi
  if [ -n "$addr" ]; then ok "$key pool      $addr"
  else bad "$record has no pool entry"; fi
done < <(printf '%s\n' "$DESTINATIONS")

# =============================================================================
section "2. Binding invariant (destination L1_POOL == canonical L1)"
note "A destination binds its L1 pool immutably. Bound to the wrong L1, ETH bridges but the"
note "note is rejected -- value is silently lost. This is the check that matters most."

while IFS='|' read -r key chain_id record app_prefix env_prefix kind; do
  [ -n "$key" ] || continue
  [ -f "$record" ] || { skip "$key not deployed"; continue; }
  if [ "$kind" = starknet ]; then
    bound=$(rec_get "$record" StarknetPrivacyPool l1Pool)
  else
    bound=$(rec_get "$record" L2PrivacyPool l1Pool)
  fi
  if [ -z "$bound" ]; then
    warn "$key record does not state l1Pool -- cannot verify binding offline"
  elif [ "$(norm_addr "$bound")" = "$(norm_addr "$L1_POOL")" ]; then
    ok "$key -> $bound"
  else
    bad "$key -> $bound\n        expected $L1_POOL -- THIS DESTINATION WILL LOSE VALUE"
  fi
done < <(printf '%s\n' "$DESTINATIONS")

# =============================================================================
section "3. packages/contracts/.env (deploy inputs)"
if [ ! -f "$CONTRACTS_ENV" ]; then
  warn "$CONTRACTS_ENV missing (only needed to run a deploy)"
else
  cmp_addr "L1_POOL_ADDRESS"    "$L1_POOL"    "$(env_get "$CONTRACTS_ENV" L1_POOL_ADDRESS)"
  cmp_addr "ENTRYPOINT_ADDRESS" "$ENTRYPOINT" "$(env_get "$CONTRACTS_ENV" ENTRYPOINT_ADDRESS)"

  while IFS='|' read -r key chain_id record app_prefix env_prefix kind; do
    [ -n "$key" ] || continue
    [ -f "$record" ] || continue
    if [ "$kind" = starknet ]; then
      want=$(rec_get "$record" StarknetPrivacyPool address)
      cmp_felt "${env_prefix}_L2_POOL_FELT" "$want" "$(env_get "$CONTRACTS_ENV" "${env_prefix}_L2_POOL_FELT")"
    else
      want=$(rec_get "$record" L2PrivacyPool address)
      cmp_addr "${env_prefix}_L2_POOL_ADDRESS" "$want" "$(env_get "$CONTRACTS_ENV" "${env_prefix}_L2_POOL_ADDRESS")"
    fi
  done < <(printf '%s\n' "$DESTINATIONS")
fi

# =============================================================================
section "4. app/.env"
if [ ! -f "$APP_ENV" ]; then
  bad "$APP_ENV missing -- the app cannot serve /api/config"
else
  cmp_addr  "POOL_ADDRESS"       "$L1_POOL"     "$(env_get "$APP_ENV" POOL_ADDRESS)"
  cmp_addr  "ENTRYPOINT_ADDRESS" "$ENTRYPOINT"  "$(env_get "$APP_ENV" ENTRYPOINT_ADDRESS)"
  cmp_exact "POOL_SCOPE"         "$L1_SCOPE"    "$(env_get "$APP_ENV" POOL_SCOPE)"
  cmp_exact "DEPLOYMENT_BLOCK"   "$L1_BLOCK"    "$(env_get "$APP_ENV" DEPLOYMENT_BLOCK)"
  cmp_exact "CHAIN_ID"           "$L1_CHAIN_ID" "$(env_get "$APP_ENV" CHAIN_ID)"

  while IFS='|' read -r key chain_id record app_prefix env_prefix kind; do
    [ -n "$key" ] || continue
    [ -f "$record" ] || { skip "$key not deployed"; continue; }
    if [ "$kind" = starknet ]; then
      cmp_felt "STARKNET_POOL_ADDRESS"  "$(rec_get "$record" StarknetPrivacyPool address)" "$(env_get "$APP_ENV" STARKNET_POOL_ADDRESS)"
      cmp_felt "STARKNET_ASSET_ADDRESS" "$(rec_get "$record" StarknetPrivacyPool asset)"   "$(env_get "$APP_ENV" STARKNET_ASSET_ADDRESS)"
      # The Cairo record carries no deploymentBlock, so this can only be sanity-checked.
      sn_block=$(env_get "$APP_ENV" STARKNET_DEPLOYMENT_BLOCK)
      if [ -z "$sn_block" ] || [ "$sn_block" = 0 ]; then
        warn "STARKNET_DEPLOYMENT_BLOCK is ${sn_block:-unset} -- starknet_getEvents pages by block range, so scanning from 0 costs ~148 sequential round-trips per event type"
      else
        ok "STARKNET_DEPLOYMENT_BLOCK = $sn_block ${DIM}(absent from the record; not cross-checked)${RST}"
      fi
    else
      cmp_addr  "${app_prefix}_POOL_ADDRESS"     "$(rec_get "$record" L2PrivacyPool address)"        "$(env_get "$APP_ENV" "${app_prefix}_POOL_ADDRESS")"
      cmp_exact "${app_prefix}_DEPLOYMENT_BLOCK" "$(rec_get "$record" L2PrivacyPool deploymentBlock)" "$(env_get "$APP_ENV" "${app_prefix}_DEPLOYMENT_BLOCK")"
      cmp_exact "${app_prefix}_CHAIN_ID"         "$chain_id"                                          "$(env_get "$APP_ENV" "${app_prefix}_CHAIN_ID")"
    fi
  done < <(printf '%s\n' "$DESTINATIONS")
fi

# =============================================================================
section "5. Destination exposure (L2_EVM_CHAINS)"
note "A destination can be deployed, bound and bridge-configured yet still invisible: the app"
note "only advertises keys listed in L2_EVM_CHAINS. That is exactly how Base stayed dark."

if [ -f "$APP_ENV" ]; then
  EVM_CHAINS=$(lc "$(env_get "$APP_ENV" L2_EVM_CHAINS)")

  while IFS='|' read -r key chain_id record app_prefix env_prefix kind; do
    [ -n "$key" ] || continue
    [ "$kind" = evm ] || continue
    [ -f "$record" ] || continue
    if printf '%s' ",${EVM_CHAINS}," | grep -q ",${key},"; then
      ok "$key is deployed and advertised"
    else
      bad "$key is deployed but MISSING from L2_EVM_CHAINS (=\"$EVM_CHAINS\") -- the app will not offer it"
    fi
  done < <(printf '%s\n' "$DESTINATIONS")

  # And the reverse: advertised but unknown here.
  while read -r key; do
    key=$(printf '%s' "$key" | tr -d '[:space:]')
    [ -n "$key" ] || continue
    if ! printf '%s\n' "$DESTINATIONS" | grep -q "^${key}|"; then
      warn "L2_EVM_CHAINS lists \"$key\", which has no known deployment record"
    fi
  done < <(printf '%s' "$EVM_CHAINS" | tr ',' '\n')
fi

# =============================================================================
section "6. packages/relayer"
RELAYER_ENV=packages/relayer/.env
RELAYER_CFG=packages/relayer/config.sepolia.json

if [ ! -f "$RELAYER_ENV" ]; then
  warn "$RELAYER_ENV missing -- relayer falls back to ./config.json and exits if absent"
else
  cfg_path=$(env_get "$RELAYER_ENV" CONFIG_PATH)
  if [ -z "$cfg_path" ]; then
    bad "CONFIG_PATH is unset -- the relayer looks for ./config.json and exits if missing"
  else
    resolved="packages/relayer/${cfg_path#./}"
    if [ -f "$resolved" ]; then
      ok "CONFIG_PATH = $cfg_path"
      RELAYER_CFG=$resolved
    else
      bad "CONFIG_PATH = $cfg_path, but $resolved does not exist"
    fi
  fi
  asp=$(lc "$(env_get "$RELAYER_ENV" TESTNET_ASP_MODE)")
  if [ "$asp" = true ]; then ok "TESTNET_ASP_MODE = true"
  else warn "TESTNET_ASP_MODE = ${asp:-unset} -- /relayer/asp/proof/:label will 404 and withdrawals cannot prove association"; fi
fi

if [ ! -f "$RELAYER_CFG" ]; then
  bad "$RELAYER_CFG missing"
else
  cfg_name=$(basename "$RELAYER_CFG")
  ep=$(jq -r --argjson id "$L1_CHAIN_ID" \
    'first(.chains[] | select(.chain_id == $id) | .entrypoint_address) // empty' "$RELAYER_CFG" 2>/dev/null)
  if [ -z "$ep" ]; then
    bad "$cfg_name has no chain entry for $L1_CHAIN_ID"
  else
    cmp_addr  "$cfg_name entrypoint_address"     "$ENTRYPOINT" "$ep"
    cmp_addr  "$cfg_name asp_pools[0].pool_address" "$L1_POOL" \
      "$(jq -r --argjson id "$L1_CHAIN_ID" 'first(.chains[] | select(.chain_id == $id) | .asp_pools[0].pool_address) // empty' "$RELAYER_CFG" 2>/dev/null)"
    cmp_exact "$cfg_name asp_pools[0].start_block" "$L1_BLOCK" \
      "$(jq -r --argjson id "$L1_CHAIN_ID" 'first(.chains[] | select(.chain_id == $id) | .asp_pools[0].start_block) // empty' "$RELAYER_CFG" 2>/dev/null)"
  fi

  # A committed provider key is a live credential sitting in git history.
  if git ls-files --error-unmatch "$RELAYER_CFG" >/dev/null 2>&1; then
    if jq -r '.. | strings' "$RELAYER_CFG" 2>/dev/null | grep -qE '(/v3/|/rpc/v[0-9_]+/)[A-Za-z0-9_-]{16,}'; then
      warn "$cfg_name is git-tracked and holds an RPC URL with an embedded API key -- rotate it, move the URL to .env"
    fi
    if jq -r '.. | strings' "$RELAYER_CFG" 2>/dev/null | grep -qE '^0x[0-9a-fA-F]{64}$'; then
      bad "$cfg_name is git-tracked and holds what looks like a private key"
    fi
  fi
fi

# =============================================================================
section "7. packages/starknet-pool/.env"
SN_ENV=packages/starknet-pool/.env
SN_REC=packages/starknet-pool/deployments/starknet-0x534e5f5345504f4c4941.json
if [ ! -f "$SN_ENV" ]; then
  warn "$SN_ENV missing (only needed to deploy the Cairo pool)"
else
  cmp_addr "starknet-pool L1_POOL_ADDRESS" "$L1_POOL" "$(env_get "$SN_ENV" L1_POOL_ADDRESS)"
  if [ -f "$SN_REC" ]; then
    cmp_felt "SN_ASSET_ADDRESS" "$(rec_get "$SN_REC" StarknetPrivacyPool asset)" "$(env_get "$SN_ENV" SN_ASSET_ADDRESS)"
  fi
fi

# =============================================================================
section "8. packages/sdk"
# Reported rather than skipped silently, so the coverage question is answered:
# the SDK is a library that takes addresses from callers -- nothing here can drift.
ok "no address surface (SDK takes config from callers; only HYPERSYNC_API_KEY is read, in tests)"

# =============================================================================
section "9. Stale records"
note "Records bound to a non-canonical L1. Kept as history -- never wire these."
STALE=0
for f in packages/contracts/deployments/*.json packages/starknet-pool/deployments/*.json; do
  [ -f "$f" ] || continue
  [ "$f" = "$L1_REC" ] && continue
  bound=$(jq -r '[.. | objects | select(has("l1Pool")) | .l1Pool] | .[0] // empty' "$f" 2>/dev/null)
  [ -z "$bound" ] && bound=$(jq -r '.l1.privacyPool // empty' "$f" 2>/dev/null)
  [ -z "$bound" ] && continue
  if [ "$(norm_addr "$bound")" != "$(norm_addr "$L1_POOL")" ]; then
    warn "$f -> $bound ${DIM}(not canonical)${RST}"
    STALE=$((STALE + 1))
  fi
done
[ "$STALE" = 0 ] && ok "every record stating an l1Pool binds the canonical L1"

# =============================================================================
if [ "$ONCHAIN" = 1 ]; then
  section "10. On-chain verification"

  L1_RPC=$(env_get "$CONTRACTS_ENV" ETHEREUM_SEPOLIA_RPC)
  [ -z "$L1_RPC" ] && L1_RPC=$(env_get "$APP_ENV" PUBLIC_RPC_URL)

  if [ -z "$L1_RPC" ]; then
    warn "no L1 RPC (ETHEREUM_SEPOLIA_RPC / PUBLIC_RPC_URL) -- skipping on-chain checks"
  else
    note "L1 via $(redact "$L1_RPC")"

    code=$(cast code "$L1_POOL" --rpc-url "$L1_RPC" 2>/dev/null)
    if [ -z "$code" ] || [ "$code" = 0x ]; then
      bad "no code at L1 pool $L1_POOL -- the record claims a deployment that is not on chain"
    else
      ok "L1 pool has code"
      onchain_scope=$(cast call "$L1_POOL" "SCOPE()(uint256)" --rpc-url "$L1_RPC" 2>/dev/null | awk '{print $1}')
      [ -n "$onchain_scope" ] && cmp_exact "L1 SCOPE() on chain" "$L1_SCOPE" "$onchain_scope"
    fi

    code=$(cast code "$ENTRYPOINT" --rpc-url "$L1_RPC" 2>/dev/null)
    if [ -z "$code" ] || [ "$code" = 0x ]; then bad "no code at entrypoint $ENTRYPOINT"; else ok "entrypoint has code"; fi

    # Does the entrypoint actually route each destination to the pool we think it does?
    BRIDGE_SIG='getBridgeConfig(uint256,address)((uint8,bool,address,address,address,uint256,uint256,address,uint256,uint256,uint256,uint256,uint256,uint256))'
    while IFS='|' read -r key chain_id record app_prefix env_prefix kind; do
      [ -n "$key" ] || continue
      [ -f "$record" ] || continue

      raw=$(cast call "$ENTRYPOINT" "$BRIDGE_SIG" "$chain_id" "$NATIVE_ASSET" --rpc-url "$L1_RPC" 2>/dev/null)
      if [ -z "$raw" ]; then
        bad "$key: getBridgeConfig($chain_id) reverted or returned nothing"
        continue
      fi
      flat=$(printf '%s' "$raw" | tr -d '()' | tr '\n' ' ' | tr ',' ' ')
      supported=$(printf '%s' "$flat" | awk '{print $2}')
      cfg_pool=$(printf '%s' "$flat" | awk '{print $5}')
      cfg_felt=$(printf '%s' "$flat" | awk '{print $6}' | sed -E 's/\[.*//')

      if [ "$supported" != true ]; then
        bad "$key: entrypoint bridge config isSupported=false -- not wired (yarn configure:bridge:${key}-sepolia)"
        continue
      fi
      if [ "$kind" = starknet ]; then
        want=$(rec_get "$record" StarknetPrivacyPool address)
        # getBridgeConfig returns l2PoolFelt as a uint256, which cast renders in decimal;
        # the record stores it in hex. Convert to a common base before comparing.
        cfg_felt_hex=$(cast to-hex "$cfg_felt" 2>/dev/null)
        if [ "$(norm_felt "$want")" = "$(norm_felt "$cfg_felt_hex")" ]; then ok "$key: entrypoint routes to $want"
        else bad "$key: entrypoint routes to l2PoolFelt $cfg_felt ($cfg_felt_hex)\n        expected $want"; fi
      else
        want=$(rec_get "$record" L2PrivacyPool address)
        if [ "$(norm_addr "$want")" = "$(norm_addr "$cfg_pool")" ]; then ok "$key: entrypoint routes to $cfg_pool"
        else bad "$key: entrypoint routes to $cfg_pool\n        expected $want"; fi
      fi
    done < <(printf '%s\n' "$DESTINATIONS")

    # The immutable binding, read from the chain rather than trusted from the record.
    while IFS='|' read -r key chain_id record app_prefix env_prefix kind; do
      [ -n "$key" ] || continue
      [ "$kind" = evm ] || continue
      [ -f "$record" ] || continue
      upper=$(printf '%s' "$key" | tr '[:lower:]' '[:upper:]')
      rpc=$(env_get "$CONTRACTS_ENV" "${upper}_SEPOLIA_RPC")
      [ -z "$rpc" ] && rpc=$(env_get "$APP_ENV" "${upper}_RPC_URL")
      [ -z "$rpc" ] && { warn "$key: no RPC configured -- cannot read L1_POOL() on chain"; continue; }

      pool=$(rec_get "$record" L2PrivacyPool address)
      code=$(cast code "$pool" --rpc-url "$rpc" 2>/dev/null)
      if [ -z "$code" ] || [ "$code" = 0x ]; then
        bad "$key: no code at $pool -- the record claims a deployment that is not on chain"
        continue
      fi
      bound=$(cast call "$pool" "L1_POOL()(address)" --rpc-url "$rpc" 2>/dev/null | awk '{print $1}')
      if [ -z "$bound" ]; then
        warn "$key: L1_POOL() call failed"
      elif [ "$(norm_addr "$bound")" = "$(norm_addr "$L1_POOL")" ]; then
        ok "$key: on-chain L1_POOL() = $bound"
      else
        bad "$key: on-chain L1_POOL() = $bound\n        expected $L1_POOL -- THIS DESTINATION WILL LOSE VALUE"
      fi
    done < <(printf '%s\n' "$DESTINATIONS")
  fi
else
  section "10. On-chain verification"
  skip "offline run -- pass --onchain to verify code, bridge routing and L1_POOL() against live chains"
fi

# =============================================================================
printf "\n${BLD}Summary${RST}  ${GRN}%d passed${RST}  ${RED}%d failed${RST}  ${YLW}%d warnings${RST}\n" "$PASS" "$FAIL" "$WARN"
if [ "$FAIL" -gt 0 ]; then
  printf "${RED}Deployment and configuration have drifted.${RST} Source of truth is deployments/*.json.\n"
  exit 1
fi
printf "${GRN}Every consumer matches the deployment records.${RST}\n"
exit 0
