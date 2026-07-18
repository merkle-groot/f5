# Arbitrum destination support

How Cutout bridges a Mode-3 withdrawal to a shielded pool on **Arbitrum** (One / Nova / Sepolia),
what makes Arbitrum different from the OP-Stack destinations, and how to deploy and operate it.

> TL;DR — Arbitrum is EVM but **not** OP-Stack. It has no L2 cross-domain messenger and prepays
> L1→L2 execution up front. So it gets its own destination pool (`L2PrivacyPoolArbitrum`) whose only
> difference from the OP-Stack pool is cross-domain **auth by address aliasing**, its own L1 bridge
> code path (`_bridgeArbitrum`), and a `payable` note intake so native ETH can ride the retryable.

---

## 1. Why Arbitrum needs its own path

| | OP-Stack (Optimism, Base) | **Arbitrum** |
|---|---|---|
| Note message | `L1CrossDomainMessenger.sendMessage` | Inbox `createRetryableTicket` |
| Token lock | `L1StandardBridge.bridge{ERC20,ETH}To` | L1 Gateway Router `outboundTransferCustomRefund` |
| L1→L2 fee | none (message runs on L1-derived gas) | **prepaid**: `submissionCost + gasLimit·maxFeePerGas`, per op |
| Native value | separate `bridgeETHTo` op | rides as the retryable's `l2CallValue` — **one** ticket, not two |
| L2 sender seen by pool | messenger, `xDomainMessageSender() == L1Pool` | L1 pool's **aliased** address (`L1Pool + 0x1111…1111`) |
| Cross-domain auth | ask the messenger who sent it | undo the alias: `undoL1ToL2Alias(msg.sender) == L1Pool` |

The two structural consequences:

1. **No messenger → auth by aliasing.** An Arbitrum L1→L2 retryable executes on L2 as a *direct call*
   to the target, with `msg.sender` set to the L1 caller's address offset by the fixed Arbitrum alias
   constant. The destination pool recovers the L1 sender by undoing that offset.
2. **Prepaid fee, fronted by the relayer.** Arbitrum charges for L2 execution at ticket-creation time
   on L1. The pool never spends its own principal on this; the relayer prepays it as `msg.value` and
   is reimbursed through the relay fee (priced into its quote). The pool refunds any unused excess.

---

## 2. Contracts

### `L2PrivacyPoolArbitrum` — `packages/contracts/src/contracts/L2/L2PrivacyPoolArbitrum.sol`

Inherits the **entire** pool body (state tree, backing invariant, `activateNote`, `withdraw`) from
`L2PrivacyPool`. It overrides exactly one hook:

```solidity
function _authenticateNote() internal view override {
  if (AddressAliasHelper.undoL1ToL2Alias(msg.sender) != L1_POOL) revert NotL1Pool();
}
```

and is constructed with `messenger = address(0)` (Arbitrum has none). The base `deposit` is `payable`
so a native retryable's `l2CallValue` lands on the pool as backing and activates the note in the same
ticket. The base pool was refactored minimally to enable this: the OP-Stack auth moved into a
`virtual _authenticateNote()` hook (default behavior unchanged), `deposit` became `payable`, and a
zero messenger is permitted (an OP-Stack pool built that way fails closed).

- `AddressAliasHelper` — `packages/contracts/src/contracts/lib/AddressAliasHelper.sol`. The canonical
  `±0x1111000000000000000000000000000000001111` alias math.

### L1 send side — `PrivacyPool._bridgeArbitrum`

Already present in `PrivacyPool.sol`; `_bridge` dispatches to it on `BridgeKind.Arbitrum`:

- **Native**: one `createRetryableTicket{value: msgFee + value}` — `l2CallValue = value` carries the
  ETH, the note message is the ticket calldata (`deposit(value, C_dest)`). Only `msgFee` comes from
  the relayer's `msg.value`; `value` is pool principal.
- **ERC20**: a note ticket (no call value) **plus** a gateway token lock via
  `IL1GatewayRouter.outboundTransferCustomRefund`; the ERC20 allowance targets
  `router.getGateway(token)`, not the router.
- Reverts `InsufficientBridgeFee` if `msg.value` can't cover the required fee(s); refunds any excess.

---

## 3. SDK & relayer

- **SDK** — `ContractInteractionsService.bridgeMsgValue(asset, destChainId)` (public) mirrors
  `_bridge` and returns the exact `msg.value` a `relay()` must attach (0 for OP-Stack, the retryable
  fee for Arbitrum). `relay()` attaches it automatically.
- **Relayer** — `POST /relayer/quote` accepts an optional `destinationChainId`. When present, the
  relayer reads `bridgeMsgValue` and folds that fronted fee into the quoted `feeBPS`, so relaying to
  Arbitrum is reimbursed rather than paid at a loss. Reads the same on-chain bridge config the pool
  enforces, so quote and relay never drift.

---

## 4. Fee model — static (current)

`_bridgeArbitrum` reads **static** retryable fee terms from the on-chain `BridgeConfig`
(`messageFee` = `maxSubmissionCost`, `messageMaxFeePerGas`, `messageGasLimit`; ERC20 adds the `token*`
equivalents). Required prepaid `msg.value` for a native relay:

```
msg.value = messageFee + messageGasLimit · messageMaxFeePerGas
```

Arbitrum's real `maxSubmissionCost` and L2 gas price are **dynamic**, so the configured terms are
**padded**: if L1 basefee or L2 gas spikes above them a ticket can fail to auto-redeem (the note/value
then sits as a manually-redeemable retryable). The pool refunds any unused prepaid `msg.value` to the
relayer, so over-padding only costs a larger up-front float, not lost funds. A future option is to
move to relayer-computed live params; static is the current, deliberate choice.

**Sepolia static defaults** (in `packages/contracts/.env`, `ARB_SEPOLIA_*`):

| Term | Value | Meaning |
|---|---|---|
| `MESSAGE_GAS_LIMIT` | `1000000` | retryable gasLimit for `deposit()` |
| `MESSAGE_MAX_FEE_PER_GAS` | `200000000` (0.2 gwei) | L2 gas price ceiling |
| `MESSAGE_SUBMISSION_COST` | `100000000000000` (1e14 = 0.0001 ETH) | maxSubmissionCost |

→ native relay fronts `1e14 + 1_000_000·2e8 = 3e14 wei` (0.0003 ETH) per relay.

---

## 5. Deployment

### Canonical L1 (Ethereum Sepolia) endpoints — verified on-chain

| | Address |
|---|---|
| Arbitrum Delayed Inbox | `0xaAe29B0366299461418F5324a79Afc425BE5ae21` |
| L1 Gateway Router | `0xcE18836b233C83325Cc8848CA4487e94C6288264` |
| Arbitrum Sepolia chain id | `421614` |

(Source: Arbitrum docs "contract addresses"; both confirmed to have code on Sepolia.)

### Scripts

- `script/DeployL2Arbitrum.s.sol` → `L2PrivacyPoolArbitrum` (alias auth, no messenger).
  yarn alias: `deploy:l2:arb-sepolia`.
- `script/ConfigureArbitrumBridge.s.sol` → owner sets `BridgeConfig{kind: Arbitrum}` on the L1
  Entrypoint, native + ERC20. yarn alias: `configure:bridge:arb-sepolia`.

### No L1 redeploy required

The L1 `_bridgeArbitrum` path and `BridgeKind.Arbitrum` were already in the deployed contracts. Verified
on Sepolia: the deployed pool `0xf913…`'s runtime bytecode matches the current compile exactly, and the
deployed Entrypoint `0x4113…` decodes the current 14-field `BridgeConfig`. So enabling Arbitrum is only
(1) deploy the L2 pool and (2) `setBridgeConfig` for chain `421614` — a config write on the existing
Entrypoint. The immutable L1 pool and the (UUPS) Entrypoint are untouched.

### Runbook

```bash
cd packages/contracts
# 0. Fund the deployer with Arbitrum Sepolia ETH (~0.0002 ETH is plenty; deploy costs ~0.00011).

# 1. Deploy the destination pool on Arbitrum Sepolia
yarn deploy:l2:arb-sepolia --broadcast
#    → copy the printed L2PrivacyPoolArbitrum address into ARB_SEPOLIA_L2_POOL_ADDRESS in .env

# 2. Point the L1 Entrypoint's bridge config at it (runs on Ethereum Sepolia)
yarn configure:bridge:arb-sepolia --broadcast

# 3. Verify the destination is live and correctly bound
cd ../.. && ./ops/check-deployment.sh --onchain

# 4. Add it to the app (config-only; the app is generic over EVM L2s, no code change):
#    in app/.env, fill ARB_POOL_ADDRESS + ARB_DEPLOYMENT_BLOCK (the deploy block from step 1),
#    then append "arb" to L2_EVM_CHAINS (e.g. L2_EVM_CHAINS=op,base,arb) and restart the app server.
```

The app scaffolding (`ARB_*` block) is already in `app/.env`; it advertises the destination and drives
`activateNote` / scanning through the same generic EVM-L2 path as OP and Base. `L2_EVM_CHAINS` stays
`op,base` until the pool address is filled, so the app never offers a half-configured destination.

Both scripts have been **simulated against the live networks** and succeed; deploy ≈ 2.87M gas
(~0.00011 ETH on Arb Sepolia), configure ≈ 252k gas on Sepolia. The `onlyRole` owner check on
`setBridgeConfig` passes for the configured `OWNER_ADDRESS`.

> The broadcasts use the foundry keystore (`--account DEPLOYER`) and need its password at sign time.

---

## 6. Tests

Run the unit suites with the intended profile (via-IR + legacy-suite skip list):

```bash
cd packages/contracts && FOUNDRY_PROFILE=test forge test
```

- `test/unit/core/MergedFlow.t.sol` — L1 emit side: `test_ArbitrumNativeRelayDeliversValueAndNoteInOneTicket`,
  `test_ArbitrumERC20RelayLocksThroughGateway`, `test_RelayRevertsWhenBridgeFeeInsufficient`,
  `test_RelayRefundsExcessBridgeFee`.
- `test/unit/core/L2PrivacyPoolArbitrum.t.sol` — L2 delivery side, driving `deposit` exactly as an
  executed retryable would: alias auth (accept aliased / reject un-aliased / reject foreign), native
  single-ticket value+activation, ERC20 two-op reconciliation.
- Relayer `test/unit/quote.service.spec.ts` — the fronted bridge fee raises the quoted BPS by exactly
  its share of the withdrawn balance.

---

## 7. Status & remaining before production

- ✅ Contracts (both sides), SDK fee, relayer quote coverage, deploy + config scripts, unit tests.
- ✅ Scripts simulated green against live Arb Sepolia + Eth Sepolia.
- ⏳ **On-chain testnet deploy** — pending: fund the deployer on Arb Sepolia, then run the two
  broadcasts (keystore password).
- ⏳ **Fork/integration test** — the suites mock the Inbox/gateway; a fork test driving a *real*
  retryable into `L2PrivacyPoolArbitrum` is not yet written.
- ⏳ **Mainnet endpoints & fee tuning** — confirm Arbitrum One Inbox / L1 Gateway Router and set
  padded (or dynamic) fee terms before mainnet.
