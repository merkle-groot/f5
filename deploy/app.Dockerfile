# Build context is the REPO ROOT, not deploy/ — same rule as packages/relayer/Dockerfile,
# and for the same reason: `app` depends on `@f5/privacy-pool-sdk` via `link:../packages/sdk`,
# a workspace that is published nowhere. Installing with deploy/ or app/ as the context
# cannot resolve it.
#
# Two targets share one dependency install:
#   --target server  -> the Node API on :8787 (no keys, read-only indexer + relayer proxy)
#   --target web     -> Caddy serving the built Vite client and terminating TLS
#
# Build with:
#   docker build -f deploy/app.Dockerfile --target server -t f5-app .
#   docker build -f deploy/app.Dockerfile --target web    -t f5-web .

FROM node:22-bookworm-slim AS base
WORKDIR /build

# V8's default old-space cap is ~950 MB regardless of how much memory the host has, and
# the SDK's `dist/types` pass (rollup-plugin-dts holds the whole type graph at once) walks
# straight into it:
#   FATAL ERROR: Ineffective mark-compacts near heap limit
# This is NOT the kernel OOM killer, so host swap does not help and a larger instance does
# not either — the ceiling is internal to Node. Raising it lets the build spill into the
# 4 GB of swap that user-data.sh provisions, which is the whole reason that swap exists.
ENV NODE_OPTIONS=--max-old-space-size=3072

# Workspace manifests first so the dependency layer caches independently of source.
COPY package.json yarn.lock tsconfig.base.json ./
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/relayer/package.json ./packages/relayer/
COPY packages/circuits/package.json ./packages/circuits/
COPY packages/contracts/package.json ./packages/contracts/
RUN yarn install --frozen-lockfile --network-concurrency 1

# The app imports the SDK's built output, so the SDK is built first. This emits
# "WARN: withdrawL1 build outputs not found" — expected and harmless here. The circuit
# artifacts are NOT built in the image (that needs circom plus a powers-of-tau run, and a
# fresh run would produce keys the deployed verifiers reject); they are mounted at runtime
# over /build/packages/sdk/dist/node/artifacts. See deploy/README.md.
COPY packages/sdk/ ./packages/sdk/
RUN yarn workspace @f5/privacy-pool-sdk build

# `app` is deliberately not a root workspace — it has its own lockfile.
COPY app/package.json app/yarn.lock ./app/
RUN cd app && yarn install --frozen-lockfile --network-concurrency 1
COPY app/ ./app/


FROM base AS web-build
# The client reads every setting from /api at runtime (no import.meta.env anywhere in
# app/src), so this build is configuration-free and the same image works on any host.
RUN cd app && yarn build


FROM caddy:2-alpine AS web
COPY --from=web-build /build/app/dist /srv/www
COPY deploy/Caddyfile /etc/caddy/Caddyfile


FROM base AS server
WORKDIR /build/app
ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "server/index.mjs"]
