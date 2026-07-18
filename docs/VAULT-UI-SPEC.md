# The Vault — UI Spec (as shipped)

Reflects the implementation in `app/src/main.js`, `app/src/vault.js`, `app/src/style.css`.
For the build plan and verification log see [VAULT-UI-PLAN.md](./VAULT-UI-PLAN.md).

## Concept

The **Vault** is an embedded panel that holds a single recovery phrase (one
mnemonic) and manages the user's shielded notes. The user never funds it — value
lives as **notes in the L1 pool** and **shielded notes on each L2**. The Vault
derives keys, reads notes from chain, and drives actions. Funding always comes
from the user's external EOA at deposit time.

Theme: the existing neobrutalist **F5** system (thick borders, hard shadows, DM
Mono, cream/yellow/pink/teal). Kept deliberately calm and data-only in the dock;
loud personality stays on the landing page.

## Routing

- `#` (and any non-`#relay` hash) → the marketing **landing** page (unchanged).
- `#relay` → the **Vault app**. Locked → onboarding; unlocked → two-pane workspace.

## Screens

### 1. Onboarding (locked) — single centered card

Three sub-states, minimal:

- **First time** — "Create a shielded Vault." → **Generate recovery phrase**;
  secondary **I already have a phrase** (import via prompt).
- **Show phrase** — numbered 12-word grid; protect on this device with a **wallet
  signature** (needs EOA) or a **password** (no wallet); confirm-written checkbox;
  **Create my Vault**.
- **Returning (locked)** — **Sign to unlock** or password field + **Unlock**;
  secondary **Import a different phrase**. The unlock method is remembered.

### 2. Unlocked — two-pane workspace

- **Left (workspace):** the active flow — Home overview, Deposit, Send, or
  Receive. One thing at a time; each flow has a `← HOME` back button.
- **Right (Vault dock, sticky):** the persistent portfolio + actions.
- Below 1000px the layout stacks to one column with the dock on top.

## The Vault dock (right)

Top to bottom:

1. **Identity strip** — shielded address `(B, V)` (truncated), a `LOCAL`/
   `PUBLISHED` chip, and **Publish** (ERC-6538 registry) + **Show phrase**.
2. **Balance card** (yellow) — one **SPENDABLE** number, with `pending` and
   `withdrawn` sub-totals.
3. **Actions** — **Deposit** (primary), **Send**, **Receive**.
4. **Notes**, grouped by where they live:
   - **L1 · Ethereum** — deposit notes, with a **Recover** button (rebuild from
     phrase + on-chain deposits).
   - **One group per configured EVM L2** (e.g. **L2 · OP Sepolia**,
     **L2 · Base Sepolia**) — driven by `config.l2Chains`; the first carries the
     **Scan** button. Not a single generic "L2".
   - **L2 · Starknet** — shown only when the Starknet destination is
     reachable/bound, or when there is withdrawn history for it.

Topbar: brand, network chip, **Connect** (EOA), and **Lock** (clears in-memory
identity; the encrypted vault stays on disk).

## Note status taxonomy (pills + balance math)

- **L1:** `READY` (spendable) · `SPENT →` (sent/bridged out — history, greyed).
- **L2/Starknet:** `ACTIVATING` (received, relayer activation pending) · `SPENDABLE`
  (activated, in tree) · `WITHDRAWN ✓` (landed to a final address — history,
  greyed).
- Pill colors: teal = ready/spendable, yellow = activate/pending, muted =
  spent/withdrawn.
- **Balance:** `spendable` = READY L1 + SPENDABLE L2; `pending` = ACTIVATE L2;
  `withdrawn` = the persisted withdrawn set.
- L2 status is derived from the **already-fetched scan index** (a note present in
  the activated `proofs` with index ≥ 0 is SPENDABLE, else ACTIVATE) plus the
  local withdrawn set — no extra per-note network calls.

## Interactions

- Click a **READY L1 note** → opens **Send** pre-loaded with it.
- Click an actionable **L2 note** (ACTIVATE/SPENDABLE) → opens **Receive** and
  refreshes its on-chain status. Spent/withdrawn rows are inert history.

## Flows (left pane)

- **Deposit** — amount + asset chip; live `minimum` and `vetting fee` from
  `/api/config`; **Deposit to pool** (requires EOA; derives the note secret at the
  next unused index). On success a `READY` L1 note appears; view returns Home.
- **Send** — pick a READY L1 note · bridge target (OP / Starknet-when-usable /
  Optimism) · recipient (resolve an EOA from the registry, or paste `Bx,By,Vx,Vy`).
  Button walks `Quote & prove → Submit L1 relay → Relay submitted ✓`; the spent L1
  note flips to `SPENT`.
- **Receive** — **Scan now** searches every L2 feed and matches locally · pick a
  note from the dock · enter the final recipient (EOA, or felt252 for Starknet) ·
  status-driven button walks `Refresh → Activate → Generate proof → Submit
  withdrawal → Withdrawn ✓`; the note flips to `WITHDRAWN ✓` and moves to history.

## Data layer (`vault.js`)

- Identity mnemonic encrypted at rest (`f5-identity-v1`), unwrapped by wallet
  signature or PBKDF2 password.
- L1 note cache (`f5-notes-v1`), now carrying `status: ready|spent`.
- **L2 withdrawal history** (`f5-l2-history-v1`, new): `cDest -> { value, chain,
  recipient, hash, at }`. Written on withdraw success — the chain's status
  endpoint only ever reports `activated`, so "withdrawn" must be remembered.

## Known limitations

- Spent/withdrawn history is **best-effort per-device**: a fresh browser
  re-derives L1 notes from the phrase but not past withdrawals (display history,
  never a spend authority).
- The real on-chain round-trips (send-prove-relay, scan, activate, withdraw)
  depend on a configured relayer/ASP/L2 backend; the flow logic is unchanged from
  the previous UI.
