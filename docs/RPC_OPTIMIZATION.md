# RPC usage optimization tracker

Started: 2026-07-18

## Goal

Reduce repeated Ethereum/Starknet RPC work without weakening reorg handling or proof-root consistency. The primary success condition is that warm, repeated API requests scan only newly mined/reorg-buffer blocks and concurrent identical work is coalesced.

## Existing work preserved

The worktree already contained uncommitted changes in `app/server/index.mjs`, `app/src/main.js`, `packages/sdk/src/core/contracts.service.ts`, `FIXES.md`, and the relayer SQLite database. In particular, the L1 spent-nullifier endpoint and Starknet bound-pool retry are user work and must remain intact.

Additional L2/Arbitrum contract and test changes appeared in the shared worktree during final verification. They are unrelated concurrent work, were excluded from this implementation, and were left untouched.

## Baseline findings

- `GET /api/l2/:chain/index` creates new `DataService` instances and replays L1 `L2Note`, L2 `NoteReceived`, and L2 `NoteActivated` histories on every request.
- Scanning multiple destinations repeats the same L1 `L2Note` history once per destination.
- `GET /api/activity` incrementally caches deposits but replays all withdrawals.
- EVM status performs three separate `eth_call` requests.
- Starknet index replays two complete paginated event histories; Starknet status performs three calls, including immutable `scope`.
- The relayer fetches gas price independently in quote and request flows.
- Existing L1 caches coalesce concurrent refreshes, but sequential requests at the same head still re-scan the trailing reorg window.

## Checkpoints

### Phase 0 — baseline and tracker

Status: complete

Verification:

- Reviewed the complete diff for every already-modified source file before editing.
- Located RPC call sites in the app server, SDK `DataService`, and relayer provider/services.
- No existing source edits were overwritten.

### Phase 1 — shared clients, instrumentation, and head coalescing

Status: complete

Changes:

- Added `app/server/rpc-runtime.mjs` with one viem client per logical chain/RPC URL.
- Added a 2.5-second configurable head cache (`RPC_HEAD_TTL_MS`) with concurrent-promise coalescing.
- Added method/error/rate-limit/latency counters that never retain URLs or request parameters.
- Added opt-in `GET /api/rpc-metrics` (`RPC_METRICS_ENABLED=true`).
- Migrated direct app-server EVM client construction to the shared runtime.

Verification:

- `node --test app/server/rpc-runtime.test.mjs` — 3 passed.
- `node --check app/server/index.mjs` — passed.
- `yarn --cwd app build` — passed (existing Vite chunk-size/browser-external warnings only).

### Phase 2 — shared incremental EVM event index

Status: complete

Changes:

- Added `app/server/event-index.mjs`, keyed by chain, pool, and event signature.
- Event streams share clients and block heads, serialize chunk requests, and coalesce concurrent refreshes.
- An unchanged head returns cached logs without an `eth_getLogs` call.
- A new head removes the cached reorg overlap before refetching it, correctly handling both replaced and removed logs.
- Migrated L1 deposits, withdrawals/activity, leaves, spent nullifiers, L1 `L2Note`, and EVM L2 received/activated events.
- EVM destination scans now share one L1 `L2Note` index instead of replaying it once per destination.

Verification:

- `node --test app/server/rpc-runtime.test.mjs app/server/event-index.test.mjs` — 6 passed.
- Tests cover unchanged-head hits, chunking, concurrent coalescing, and reorg removal/replacement.
- `node --check app/server/index.mjs` — passed.
- `yarn --cwd app build` — passed (existing warnings only).

### Phase 3 — consolidated reads and relayer gas cache

Status: complete

Changes:

- Added generic TTL/in-flight read caching to the app RPC runtime.
- Cached immutable EVM pool `SCOPE` reads for the process lifetime.
- Cached L1 asset configuration for `RPC_CONFIG_TTL_MS` (default 30 seconds).
- Replaced the EVM L2 status route's three contract reads with one Multicall3 `eth_call`.
- Added a reusable typed `CoalescedTtlCache` in the relayer.
- Cached/coalesced relayer gas prices per chain for `GAS_PRICE_CACHE_MS` (default 1.5 seconds).

Verification:

- App server tests — 7 passed.
- Relayer cache tests — 2 passed.
- `yarn --cwd packages/relayer check-types` — passed.
- `node --check app/server/index.mjs` — passed.
- `yarn --cwd app build` — passed (existing warnings only).

### Phase 4 — Starknet incremental index and retry hardening

Status: complete

Changes:

- Reused one Starknet `RpcProvider` per RPC URL.
- Added a paginated incremental Starknet event index with head TTL, in-flight coalescing, and 16-block reorg rollback.
- Migrated Starknet `NoteReceived`/`NoteActivated` scans and reused the shared L1 `L2Note` index.
- Cached immutable Starknet L1-pool binding and `scope`; cached `current_root` for the short head TTL.
- Added per-chain serialization for EVM `eth_getLogs` streams (`RPC_LOG_CONCURRENCY`, default 1).
- Retries now stop immediately for permanent errors and retry only rate limits, `5xx`, network failures, `-32603`, and `-32005`.
- Retry backoff adds jitter and honors `Retry-After`.

Verification:

- First checkpoint: 12/13 app tests passed; one Starknet coalescing test released its mock before the request started. No implementation failure was observed.
- Test synchronization was corrected and the complete app-server suite passed: 13/13.
- Relayer cache tests — 2 passed.
- `node --check app/server/index.mjs` — passed.
- `yarn --cwd app build` — passed (existing warnings only).
- `yarn --cwd packages/relayer check-types` — passed.

### Final verification

Status: complete

Results:

- App server tests — 13 passed, including a 20-request identical-refresh burst collapsed onto one upstream log fetch.
- Relayer suite — 17 passed, 1 existing integration test skipped.
- Relayer type-check and production TypeScript build — passed.
- SDK type-check — passed.
- App production build — passed; only the existing Vite browser-external/chunk-size warnings remain.
- `git diff --check` — passed.
- Process smoke test on isolated port 8799 — `/api/health` returned online and `/api/rpc-metrics` returned the expected zeroed, secret-free metrics payload.
- The temporary server was stopped after the smoke test.
- The relayer build's generated `tsconfig.build.tsbuildinfo` delta was restored; no generated verification artifacts remain in the tracked diff.

## Runtime knobs

- `RPC_HEAD_TTL_MS` — shared EVM/Starknet head and short root freshness; default `2500`.
- `RPC_CONFIG_TTL_MS` — L1 asset configuration freshness; default `30000`.
- `RPC_LOG_CONCURRENCY` — concurrent EVM log windows per chain; default `1`.
- `GAS_PRICE_CACHE_MS` — relayer gas-price freshness; default `1500`.
- `STARKNET_EVENT_CHUNK_SIZE` — Starknet event page size; default `100`.
- `MULTICALL3_ADDRESS` — optional override; defaults to the canonical Multicall3 address.
- `RPC_METRICS_ENABLED=true` — enables `GET /api/rpc-metrics`.

## Expected steady-state behavior

- Repeating an index request at the same head performs no log fetch.
- A new head fetches only the reorg overlap plus new blocks.
- Concurrent identical reads share one upstream promise.
- Different event streams on the same EVM chain are serialized by default.
- All EVM destinations and Starknet share the same indexed L1 `L2Note` history.
- EVM status uses one Multicall; immutable/slow reads and relayer gas price use freshness-appropriate caches.
