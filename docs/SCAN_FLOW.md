# Unified Sequential Scan

## Goal

Replace the separate L1 **Recover** action with one **Scan** action that:

1. scans/rebuilds L1 notes first;
2. scans each configured L2 in order;
3. never starts multiple destination index requests at once; and
4. reports route-by-route progress in the Vault and Receive views.

## Phase 1 — Baseline inspection

Status: complete

- The Vault currently renders both `SCAN` and an L1-only `RECOVER` button.
- `recoverL1Notes()` rebuilds phrase-derived L1 notes, preserves legacy/spent state, and reconciles burned nullifiers.
- `scanForNotes()` currently uses `Promise.all` to fetch every EVM and Starknet index concurrently.
- Scan progress is currently only a spinner in the pressed button; it does not identify the active or completed route.
- Client scan behavior has no focused unit test yet.

Verification:

- Inspected `app/src/main.js`, `app/src/style.css`, and `app/package.json`.
- Confirmed the unrelated existing Poseidon/spent-note changes in `app/src/main.js` will be preserved.

## Phase 2 — Sequential scan implementation

Status: complete

- Removed the L1 `RECOVER` button and its click handler.
- Moved L1 phrase recovery and spent-nullifier reconciliation into the first Scan route.
- Added `runSequentialScan()`, which awaits each route before starting the next.
- Route order is L1, EVM L2s in server-config order, then Starknet when enabled or while its separate config check is still pending.
- Added persistent route statuses (`waiting`, `scanning`, `done`, `skipped`, `error`) to both the Vault notes panel and Receive flow.
- A failed route is recorded and the queue continues, so one unavailable L2 does not hide results from later L2s.

Verification:

- `npm run test:server` passed all 15 tests.
- New tests assert `maxActive === 1`, exact L1-to-L2 ordering, and continuation after an individual route failure.
- Confirmed the Scan implementation contains no `Promise.all` fan-out.

## Phase 3 — Verification

Status: complete

- `npm run test:server`: 15/15 tests passed.
- `npm run build`: production Vite build passed.
- `git diff --check`: passed.

- Static checks confirm the removed Recover control/handler/text is absent.
- Static checks confirm `scanForNotes()` contains no `Promise.all(...)` call.
- The browser-control runtime had no attached browser backend, so an automated visual click-through could not be performed in this session. The frontend templates and styles are covered by the successful production build.

## Phase 4 — Scan route logos

Status: complete

- Reuse the circular, color-coded chain badges from the `/vault` transit illustration in the scan-status list.
- Ethereum uses the teal `Ξ` badge; L2s use the same blue/pink/yellow/teal rotation and chain initials as the illustration.

Verification:

- `npm run test:server`: 15/15 tests passed.
- `npm run build`: production Vite build passed.
- `git diff --check`: passed.

## Phase 5 — Persist scanned L2 notes

Status: complete

- Root cause: L1 notes use the encrypted local note cache, while matched L2 notes exist only in the in-memory `receive.scanned` array.
- Add a separate encrypted, pool-scoped L2 scan cache and restore it during vault unlock.
- Refresh only the selected note's destination index when proof data is needed after a reload.

Implementation:

- Matched L2 notes and their scan count are AES-GCM encrypted with the mnemonic-derived vault key before entering `localStorage`.
- BigInt spend fields are serialized and safely revived on unlock/page refresh.
- Cache entries from another pool scope, an unreadable key, or malformed storage are ignored.
- A partial scan retains cached notes for any route that temporarily failed.
- Forgetting the identity removes the L1 cache, L2 scan cache, and withdrawal history.

Verification:

- `npm run test:server`: 17/17 tests passed, including encrypted L2 cache round-trip and scope isolation.
- `npm run build`: production Vite build passed.
- `git diff --check`: passed.
- `scanForNotes()` still contains no `Promise.all(...)` call.

## Phase 6 — Vault scan notice placement

Status: complete

- Place the `/vault` home notice immediately below the transit-map illustration.
- Change the notice heading from `NOTED` to `NOTE` and simplify the scan-result copy.

Result copy:

- `Scan complete. Found 4 notes across your L2 routes.`

Verification:

- `npm run test:server`: 17/17 tests passed.
- `npm run build`: production Vite build passed.
- `git diff --check`: passed.

## Phase 7 — Consistent flow notice placement

Status: complete

- Move the shared success notice below the illustration in every unlocked flow: transit map, deposit, bridge, and withdraw.
- Remove the shared notice slot above the active flow panel.

Verification:

- Confirmed all four unlocked flow templates render `noticeView()` immediately after their illustration.
- Confirmed `appShell()` no longer renders a workspace-level notice.
- `npm run test:server`: 17/17 tests passed.
- `npm run build`: production Vite build passed.
- `git diff --check`: passed.
