# Build context is the REPO ROOT, not packages/relayer.
#
# This is load-bearing. The relayer depends on `@f5/privacy-pool-sdk`, which is a
# yarn workspace in this repo and is published nowhere. Building with
# packages/relayer as the context (the previous arrangement) ran `yarn install`
# outside the workspace, so the dependency could not resolve locally — and under
# the old `@0xbow/privacy-pools-core-sdk` name it silently resolved to UPSTREAM's
# package on npm, which has no Mode-3 surface at all (src/utils.ts imports
# WITHDRAW_L1_SIGNALS, which only exists in this fork).
#
# Build with:
#   docker build -f packages/relayer/Dockerfile -t f5-relayer .
FROM node:23 AS build
ARG GIT_SHA="0000000"
ARG BUILD_DATE=

WORKDIR /build

# V8 caps old-space at ~950 MB by default, and the SDK's `dist/types` pass
# (rollup-plugin-dts, which holds the entire type graph at once) exceeds it:
#   FATAL ERROR: Ineffective mark-compacts near heap limit
# It is a V8 limit, not the kernel OOM killer, so neither host swap nor a bigger instance
# changes anything — only raising the cap does.
ENV NODE_OPTIONS=--max-old-space-size=3072

# Workspace manifests first, so dependency installation caches independently of source.
COPY package.json yarn.lock tsconfig.base.json ./
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/relayer/package.json ./packages/relayer/
COPY packages/circuits/package.json ./packages/circuits/
COPY packages/contracts/package.json ./packages/contracts/
RUN yarn install --frozen-lockfile

# The relayer imports the SDK's built output, so the SDK is built first.
COPY packages/sdk/ ./packages/sdk/
RUN yarn workspace @f5/privacy-pool-sdk build

COPY packages/relayer/ ./packages/relayer/
RUN yarn workspace @f5/relayer build

ENV GIT_SHA=$GIT_SHA
ENV BUILD_DATE=$BUILD_DATE

WORKDIR /build/packages/relayer
EXPOSE 3000
CMD ["node", "dist/index.js"]
