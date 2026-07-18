# Vault UI — Implementation Plan

Status legend: `[ ]` todo · `[~]` in progress · `[x]` done

## Goal

Replace the current tabbed relayer UI with an **embedded "Vault"** docked on the
right side of the app. On launch the Vault shows **minimal onboarding**; once
unlocked it shows the user's **notes across L1 and each L2 (including spent /
withdrawn history)** and enough actions to **deposit, send, and withdraw**.

## Decisions (locked)

- **Name:** Vault (not "wallet" — user never funds it; it derives keys from a
  phrase and reads notes from chain).
- **Theme:** keep the existing neobrutalist F5 theme/tokens. Aesthetics can be
  revisited later. Reuse existing component classes where possible.
- **Simplify hard:** show only relevant data. No marketing chrome inside the app
  view. Landing page (`#`) stays as-is; the redesign targets the app (`#relay`).
- **Reuse plumbing:** keep ALL existing crypto/flow functions (deposit, send,
  resolve, scan, activate, prove, withdraw, recover, registry). Rewrite only the
  presentation layer + add note-lifecycle persistence.

## Layout

- **Locked:** single centered onboarding card (minimal). Right dock hidden.
- **Unlocked:** two-pane workspace.
  - **Left (workspace):** the active flow — home overview, Deposit, Send, or
    Receive/Withdraw. One thing at a time.
  - **Right (Vault dock, sticky):** identity strip `(B,V)` + publish/show-phrase/
    lock · balance summary (spendable / pending / withdrawn) · action buttons
    (Deposit · Send · Receive) · notes grouped by **L1 · Ethereum**,
    **L2 · Optimism**, **L2 · Starknet** (Starknet only when reachable).

## Note status taxonomy (drives pills + balance)

- **L1:** `ready` (spendable) · `spent` (sent/bridged out — history, greyed).
- **L2/Starknet:** `activating` (received, relayer activation pending) · `spendable`
  (activated, in tree) · `withdrawn` (landed to final address — history, greyed).
- L2 status is derived from the **already-fetched scan index** (a note in the
  activated `proofs` with index ≥ 0 is `spendable`, else `activate`), plus the
  locally-persisted withdrawn set. No extra per-note network calls.

## Data-layer changes

- **L1 notes:** carry `status` (`ready`/`spent`). On send success mark `spent`
  instead of deleting. On recover, **merge** status from existing notes by
  commitment (recover can't detect spend from deposits alone — best-effort local).
- **L2 history:** new vault-encrypted store `f5-l2-history-v1`, a map
  `cDest -> { value, chain, recipient, hash, at }`. Written on withdraw success.
- New `vault.js` exports: `saveL2History`, `loadL2History`.

## Work items

- [x] `vault.js`: add `L2_HISTORY_KEY`, `saveL2History`, `loadL2History`.
- [x] `main.js`: new `state` shape (`view`, `notes` w/ status, `withdrawn`).
- [x] `main.js`: `render()` routing — landing vs onboarding-shell vs app-shell.
- [x] `main.js`: onboarding shell (create / show-phrase / unlock / import).
- [x] `main.js`: Vault dock (identity strip, balance, actions, grouped notes).
- [x] `main.js`: workspace views — home, deposit, send, receive.
- [x] `main.js`: `bind()` for the new DOM (data-view nav, note picks, actions).
- [x] `main.js`: lifecycle persistence in `runSend` (spent) + `runReceive`
      (withdrawn) + `recoverL1Notes` (merge) + `scanForNotes` (annotate `_status`).
- [x] `main.js`: `lockVault()`, balance math helpers, L2 status derivation.
- [x] `style.css`: append Vault-dock + workspace layout + status pills (reuse
      existing `.panel/.primary/.note/.input-label/.flow-step/.notice` tokens).
- [x] `index.html`: title tweak.
- [x] Verify: `vite build` passes; browser smoke test (stubbed API) confirmed
      onboarding → create/unlock → two-pane portfolio → DEPOSIT flow render with
      **no console errors**; balance math + grouped note empty-states work.

## Verified (2026-07-16, browser smoke test)

- Onboarding card renders in F5 theme; locked state is single centered card.
- Password-method create → unlock → `afterUnlock` loads notes + L2 history.
- Unlocked two-pane: workspace-main (left) + sticky Vault dock (right).
- Dock: identity strip `(B,V)` + LOCAL/PUBLISHED, yellow SPENDABLE card
  (spendable/pending/withdrawn), DEPOSIT/SEND/RECEIVE, grouped notes L1/L2.
- Action buttons swap the LEFT pane to the flow (DEPOSIT form pulled live
  `minimum`/`vetting fee` from config); ← HOME returns to overview.
- Responsive: below 1000px stacks to one column with the dock on top.

## Not exercised (needs a configured backend + wallet)

- Real deposit / send-prove-relay / scan / activate / withdraw round-trips.
- On-chain registry publish + resolve. These reuse the pre-existing flow code
  verbatim (no logic changed), so risk is confined to the presentation rewrite.

## Guardrails (from FIXES.md)

- Do **not** hand-copy public-signal indices, event ABIs, or versions. All flow
  logic that touches those is reused verbatim from the current `main.js` — no
  re-derivation. Presentation changes only.

## Notes / risks

- Withdrawn/spent history is **best-effort local** (per-device). Flagged to user.
- Cramped right column: action forms live in the LEFT pane, not the dock, so the
  dock stays calm and data-only.
