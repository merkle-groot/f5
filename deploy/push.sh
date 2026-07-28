#!/usr/bin/env bash
# Ship this working tree to the instance and bring the stack up. Run from anywhere:
#
#   F5_HOST=ec2-user@203.0.113.7 F5_KEY=~/.ssh/f5.pem deploy/push.sh
#
# This is an rsync deploy rather than a `git clone` on the box, and that is deliberate.
# The proving artifacts under packages/sdk/dist/node/artifacts are gitignored and exist
# nowhere but this machine, so a clone produces a tree that builds fine and then fails
# every proof at artifact fetch. Regenerating them on the server is worse than useless:
# `yarn setup:all` re-runs the phase-2 contribution with fresh randomness, producing keys
# whose `delta` no longer matches the deployed verifiers, and the only symptom is
# InvalidProof() from the chain. Copy, never rebuild.
set -euo pipefail

# --partial on every transfer below is not decoration: the artifacts alone are ~40 MB and
# this is often run over a flaky link. Without it a dropped connection restarts the whole
# transfer from zero. Re-running the script resumes.

HERE="$(cd "$(dirname "$0")/.." && pwd)"
: "${F5_HOST:?set F5_HOST, e.g. ec2-user@203.0.113.7}"
KEY_OPT=()
[ -n "${F5_KEY:-}" ] && KEY_OPT=(-e "ssh -i ${F5_KEY} -o StrictHostKeyChecking=accept-new")

ARTIFACTS="$HERE/packages/sdk/dist/node/artifacts"
[ -f "$ARTIFACTS/withdrawL1.zkey" ] || {
  echo "FATAL: no proving artifacts at $ARTIFACTS" >&2
  echo "       Build them locally first (packages/circuits: yarn compile && yarn setup:all," >&2
  echo "       then yarn present) and re-run. Do NOT generate them on the server." >&2
  exit 1
}

echo "==> source"
rsync -az --partial --timeout=60 --delete "${KEY_OPT[@]}" \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'build' \
  --exclude 'out' \
  --exclude 'cache' \
  --exclude 'deploy/artifacts' \
  --exclude 'deploy/config' \
  --exclude '*.env' \
  --exclude 'config.json' \
  --exclude 'config.sepolia.json' \
  "$HERE/" "$F5_HOST:/opt/f5/"

# Separate pass: the artifacts live under a `dist` path excluded above, and they are the
# one build output that must survive the trip.
echo "==> proving artifacts ($(du -sh "$ARTIFACTS" | cut -f1))"
rsync -az --partial --timeout=60 "${KEY_OPT[@]}" "$ARTIFACTS/" "$F5_HOST:/opt/f5/deploy/artifacts/"

# Secrets go over the same channel but are never part of the source sync, so a stray
# `--delete` on the tree cannot wipe them and nothing secret is in the rsync'd repo.
if [ -d "$HERE/deploy/config" ]; then
  echo "==> config"
  rsync -az --partial --timeout=60 "${KEY_OPT[@]}" "$HERE/deploy/config/" "$F5_HOST:/opt/f5/deploy/config/"
fi

# deploy/.env separately again: the source pass excludes '*.env' so no secret is ever
# carried by the tree sync, and that exclusion catches this file too. Compose reads it
# from its project directory (deploy/) for F5_DOMAIN, and without it `up` fails outright.
if [ -f "$HERE/deploy/.env" ]; then
  echo "==> compose env"
  rsync -az --partial --timeout=60 "${KEY_OPT[@]}" "$HERE/deploy/.env" "$F5_HOST:/opt/f5/deploy/.env"
fi

echo "==> build and start (detached)"
# The build runs under setsid + nohup, NOT in the foreground of this ssh session.
#
# A foreground build dies with the connection: dropping the link SIGHUPs the remote
# `docker build`, and a 10-minute build over a flaky uplink loses that race repeatedly —
# it took three attempts here before this was diagnosed, because the local script keeps
# waiting on a socket whose remote process is already gone. Detached, the build survives
# the disconnect and the log is on the server to resume watching.
# shellcheck disable=SC2029
ssh ${F5_KEY:+-i "$F5_KEY"} "$F5_HOST" \
  'cd /opt/f5 && setsid nohup docker compose -f deploy/docker-compose.yml up -d --build \
     >/opt/f5/build.log 2>&1 < /dev/null & echo "started, log: /opt/f5/build.log"'

cat <<EOF

Build is running on the instance. Follow it with:
  ssh ${F5_KEY:+-i $F5_KEY} $F5_HOST 'tail -f /opt/f5/build.log'
EOF
