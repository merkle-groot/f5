# Key derivation

How every key in Cutout comes out of one recovery phrase.

Twelve words are the **only** thing a user backs up. Everything below is derived from them — the L1
note secrets, the shielded spend/view keys, and the key that encrypts the local vault. Nothing is
derived from a wallet signature.

---

## The whole picture

```
                     12-word BIP-39 mnemonic
                              │
                              ▼
                    BIP-39 seed → BIP-32 HD tree
                              │
        ┌───────────┬─────────┼─────────┬───────────┐
        ▼           ▼         ▼         ▼           ▼
    account 0   account 1  account 2  account 3  account 4
        │           │         │         │           │
   Poseidon(k)  Poseidon(k)  mod L     mod L    keccak(domain‖k)
        │           │         │         │           │
        ▼           ▼         ▼         ▼           ▼
  masterNullifier masterSecret   b         v       vaultKey
        └─────┬─────┘            │         │           │
              │                  ▼         ▼           ▼
              │               B = b·G   V = v·G   AES-GCM key
              │                  └────┬────┘          │
              ▼                       ▼               ▼
      L1 note secrets        shielded address   encrypted note
   (nullifier, secret)            (B, V)             cache
```

Each HD account is used for exactly one purpose. That's the domain separation: a leak of one derived
value cannot be walked back into another.

| HD account | Produces | Used for |
|---|---|---|
| 0 | `masterNullifier` | L1 note nullifiers |
| 1 | `masterSecret` | L1 note secrets |
| 2 | `b` (spend key) | **spending** a shielded note on L2 |
| 3 | `v` (view key) | **finding** notes addressed to you |
| 4 | `vaultKey` | encrypting the local note cache |

Accounts 0 and 1 predate this work (`generateMasterKeys`). Accounts 2, 3 and 4 were added in
`packages/sdk/src/identity.ts`. **Do not reuse 0 or 1 for anything new.**

---

## Step 1 — mnemonic to HD keys

Standard BIP-39 → BIP-32, via viem's `mnemonicToAccount(mnemonic, { accountIndex })`. Each account
index yields a distinct 32-byte private key.

We do **not** use those keys as secp256k1 keys. We use them purely as **256 bits of domain-separated
entropy**, then reshape each into whatever the consumer needs.

> ### ⚠️ `bytesToNumber` on key material is a catastrophe
>
> The original code did this:
>
> ```ts
> const key1 = bytesToNumber(hdKey);   // returns a JavaScript `number`
> const masterNullifier = poseidon([BigInt(key1)]);
> ```
>
> `bytesToNumber` returns an **IEEE-754 double**. A 32-byte key is ~7.8×10⁷⁶ — vastly beyond
> `Number.MAX_SAFE_INTEGER` (2⁵³). The double keeps only its 53-bit mantissa and **silently rounds**:
>
> ```
> true key                 77814517325470205911140941194401928579557062014761831930645393041380819009408
> BigInt(bytesToNumber(k)) 77814517325470206090537488703115359743174939106526186048988649279981784924160
>                                            ^^^ diverges — the low ~203 bits are zeroed
> ```
>
> A double in `[2²⁵⁵, 2²⁵⁶)` can only land on multiples of 2²⁰³. So the master keys had **~53 bits of
> entropy each instead of 256**, and the value being hashed was not even the real private key.
>
> Nothing threw. It was found only by comparing the derived value against the raw bytes.
>
> **Fixed** — `bytesToBigInt` is the correct conversion. `bytesToNumber` must never touch key material.
> Pinned by `identity.spec.ts` → *"master keys use the FULL 32 bytes of HD entropy"*.
>
> It was safe to fix only because **the pool had zero deposits at the time**. Changing this changes
> every derived note secret — see [Changing the derivation](#changing-the-derivation-is-a-migration).

---

## Step 2 — L1 note secrets (accounts 0, 1)

```ts
masterNullifier = Poseidon( bytesToBigInt(hdKey(0)) )
masterSecret    = Poseidon( bytesToBigInt(hdKey(1)) )
```

Poseidon maps the raw key into the BN254 scalar field, which is where the circuits live.

Each deposit then derives its own pair, salted by the **pool scope** and an **index**:

```ts
nullifier = Poseidon( masterNullifier, scope, index )
secret    = Poseidon( masterSecret,    scope, index )

precommitment = Poseidon( nullifier, secret )          // what you send on-chain
commitment    = Poseidon( value, label, precommitment ) // what the pool inserts
```

Two consequences fall out of this, and both matter.

**Notes are re-derivable.** Walk `index = 0, 1, 2, …`, derive each precommitment, and look it up among
the pool's `Deposited` events. That's `recoverNotes()`. **The encrypted local vault is a cache, not the
source of truth** — losing `localStorage` is survivable. (There is a BIP-44-style gap limit, so one
reverted deposit doesn't hide every note after it.)

**The index must come from chain state, not a local counter.** Two devices sharing a mnemonic with
independent counters would derive the *same* precommitment, and the pool rejects reuse
(`PrecommitmentAlreadyUsed`). `nextDepositIndex()` reads the chain.

Withdrawal change-notes use the same scheme, salted by `label` instead of `scope`
(`generateWithdrawalSecrets`).

---

## Step 3 — shielded keys (accounts 2, 3)

These live on **Baby Jubjub**, not secp256k1. That is forced, not a preference: the spend key
authorizes a Poseidon commitment **opening inside a circuit** — it never signs a transaction
(CLAUDE.md §8).

```ts
b = bytesToBigInt(hdKey(2)) mod L        // spend scalar
v = bytesToBigInt(hdKey(3)) mod L        // view  scalar
B = b·G                                  // spend public key
V = v·G                                  // view  public key
```

`L` is the Baby Jubjub prime-order subgroup order (~2²⁵¹). Reducing a uniform 256-bit value mod `L`
introduces a negligible modulo bias and is the standard way to turn HD entropy into a curve scalar. A
zero scalar is rejected as degenerate.

**`(B, V)` is your shielded address.** It is public — hand it out. It is all a sender may ever have.

**Why `b` and `v` are separate HD accounts, not one key split two ways:** `v` alone is enough to *find*
notes; `b` is required to *spend* them. Separate accounts mean a watch-only setup can hold `v` without
`b`.

---

## Step 4 — the vault key (account 4)

```ts
vaultKey = keccak256("f5.vault.v1:" + hdKey(4).toString(16))   // 32 bytes → AES-GCM
```

Domain-separated from the HD key itself, so a leak of the vault key cannot be walked back to the
account-4 private key. It encrypts the local note cache — which, per Step 2, is only a cache.

---

## Where the mnemonic itself lives

The vault key comes *from* the mnemonic, so the mnemonic has to survive between sessions. It is stored
encrypted in `localStorage` under one of two **unwrap** keys:

| Method | Key derivation | Why |
|---|---|---|
| **Wallet** | `SHA-256(signature over a fixed message)` | One click. Keeps the existing UX for depositors. |
| **Password** | `PBKDF2(password, salt, 250k, SHA-256)` | **No wallet needed at all** — a pure recipient should not need an EOA to receive. |

> ### The wallet is an unwrap key, never a root key
>
> It is tempting to derive `(b, v)` straight from a wallet signature and store nothing. **Don't.**
>
> Signatures are only deterministic for RFC-6979 signers. Plenty of smart-contract wallets and
> WalletConnect implementations are not. A signature that comes back different *once* would mean keys
> that can **never** be re-derived — funds gone, with no recourse.
>
> Because the mnemonic is the root and the wallet merely unwraps it, a non-deterministic signer or a
> switched wallet is **recoverable**: you still have the twelve words.

---

## The stealth derivation (per-note, not per-identity)

The keys above are your long-lived identity. Each individual note additionally derives one-time values
from an **ephemeral scalar `e`**, fresh per note. This is what makes payments to the same address
unlinkable.

**Sender** — holds only the recipient's public `(B, V)`:

```ts
E  = e·G                      // ephemeral public key, published with the note
ss = (e·V).x                  // ECDH shared secret
P  = B + Poseidon(ss)·G       // one-time owner key
r  = Poseidon(ss, 1)          // blinding factor
C_dest  = Poseidon(P.x, P.y, value, r)      // the bridged note
viewTag = Poseidon(ss) mod 256              // cheap scan pre-filter
```

**Recipient** — recomputes the same `ss` from the other side:

```ts
ss = (v·E).x                  // same shared secret, from the VIEW key
P  = B + Poseidon(ss)·G       // confirm C_dest matches → the note is mine
sk = (b + Poseidon(ss)) mod L // one-time SPEND key, opens the commitment in-circuit
```

`ss` is derived two ways from one ECDH — `e·V` by the sender, `v·E` by the recipient — and they agree.
The sender never learns `b` or `v`; the recipient is never told the note exists.

> ### The view tag is a client-side optimisation, not a query filter
>
> Scanning tries `v·E` against every candidate note. The view tag lets you skip that scalar mult for
> ~255/256 of them — a **CPU** saving, in the browser.
>
> **Never ask the relayer for "notes with view tag 0x07".** That hands it a 1-in-256 fingerprint of the
> recipient and ties an IP to a note set. Fetch the whole feed; match locally.

---

## Changing the derivation is a migration

Every value on this page is a pure function of the mnemonic. **Change any step and every derived key
changes** — which means:

- existing L1 notes become **underivable**, so `recoverNotes()` finds nothing;
- the shielded address `(B, V)` changes, so anything published to the ERC-6538 registry is stale;
- the vault key changes, so the local note cache no longer decrypts.

The `bytesToNumber` fix above was safe **only** because the pool had zero deposits. Anyone touching the
derivation after real deposits exist must treat it as a versioned migration, not a bug fix.

This is the same trap as the `_merkleRoot` misnomer in the indexer: a "harmless cleanup" that silently
severs users from their funds.

---

## Security notes

**The mnemonic shares an HD tree with standard Ethereum accounts.** `mnemonicToAccount` uses the usual
BIP-44 Ethereum path, so importing this phrase into MetaMask exposes the *same* private keys that seed
accounts 0–4. Poseidon is one-way, so a master key doesn't leak the HD key — but the reverse holds:
**anyone who obtains the HD private keys for accounts 0 and 1 can compute both master keys, and
therefore every L1 note secret.** Use a dedicated mnemonic; do not reuse a hot wallet's phrase.

**`v` leaks your incoming payments, `b` spends them.** Handing someone `v` for auditing lets them see
every note sent to you, forever. There is no revocation.

**Amount privacy is out of scope** (CLAUDE.md §1). Values are forwarded in plaintext, so with variable
denominations the amount is the dominant residual leak. Unlinkability is bounded to the set of
same-amount notes.

---

## Where the code is

| Concern | File |
|---|---|
| Master keys, deposit/withdrawal secrets | `packages/sdk/src/crypto.ts` |
| Shielded keys, vault key, meta-address, recovery | `packages/sdk/src/identity.ts` |
| Stealth math (ECDH, `P`, `C_dest`, view tag) | `packages/sdk/src/stealth.ts` |
| Note construction + scanning | `packages/sdk/src/core/note.service.ts` |
| Mnemonic at rest, note cache | `app/src/vault.js` |
| Tests pinning all of the above | `packages/sdk/test/unit/identity.spec.ts` |
