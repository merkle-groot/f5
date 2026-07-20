# Vault Transit Map Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the shielded public address and recovery action into the Transit Map panel, make them exclusive to `/vault`, and show publication only when the connected wallet's keys are known to be unpublished.

**Architecture:** Extract the identity markup into a pure renderer so its privacy copy and conditional action can be tested without booting the browser application. `homeView()`—the renderer used only for `/vault`—will call that renderer, while the shared `appShell()` will no longer append a global identity tile. Existing event handlers and registry/mnemonic behavior remain unchanged.

**Tech Stack:** Vanilla JavaScript ES modules, Vite 6, Node.js built-in test runner, CSS.

## Global Constraints

- The identity controls render only on the exact `/vault` route, not `/vault/deposit`, `/vault/bridge`, `/vault/withdraw`, or `/vault/ragequit`.
- The publish action renders only when `state.registered === false`.
- Explain that publication associates public shielded keys with the connected wallet so senders can resolve it and deliver shielded notes.
- State that private keys and the recovery phrase remain local and are never published.
- Do not change cryptographic derivation, registry calls, mnemonic handling, clipboard behavior, or existing event IDs/data attributes.
- Preserve unrelated changes already present in `app/src/main.js` and `app/src/style.css`.

---

## File Structure

- Create `app/src/vault-identity.js`: pure HTML renderer for the Transit Map identity section.
- Create `app/src/vault-identity.test.mjs`: focused render tests for copy, public-key rows, recovery action, and publish visibility.
- Modify `app/src/main.js`: import the renderer, call it only from `homeView()`, and remove the shared standalone tile.
- Modify `app/src/style.css`: replace standalone-tile layout with embedded Transit Map identity styling.

### Task 1: Build the tested identity renderer

**Files:**
- Create: `app/src/vault-identity.js`
- Test: `app/src/vault-identity.test.mjs`

**Interfaces:**
- Consumes: `{ shielded: { B: [bigint, bigint], V: [bigint, bigint] }, account: string, registered: boolean | null, busy: boolean }`.
- Produces: `renderVaultIdentityControls(options): string`, HTML retaining `#register-keys`, `#reveal-mnemonic`, `data-copy-shielded`, and `data-copy-label` hooks used by `main.js`.

- [ ] **Step 1: Write failing renderer tests**

Create `app/src/vault-identity.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { renderVaultIdentityControls } from "./vault-identity.js";

const shielded = {
  B: [12345678901234567890n, 22345678901234567890n],
  V: [32345678901234567890n, 42345678901234567890n],
};

test("renders public shielded keys, recovery action, and publication rationale", () => {
  const html = renderVaultIdentityControls({ shielded, account: "0x1234", registered: true, busy: false });

  assert.match(html, /SHIELDED ADDRESS/);
  assert.match(html, /SPENDING KEY/);
  assert.match(html, /VIEWING KEY/);
  assert.match(html, /id="reveal-mnemonic"/);
  assert.match(html, /senders can resolve your connected wallet/i);
  assert.match(html, /private keys and recovery phrase stay local/i);
  assert.doesNotMatch(html, /id="register-keys"/);
  assert.match(html, /<code>12345678…567890 · 22345678…567890<\/code>/);
  assert.match(html, /data-copy-shielded="12345678901234567890, 22345678901234567890"/);
});

test("renders publish action only for keys known to be unpublished", () => {
  const unpublished = renderVaultIdentityControls({ shielded, account: "0x1234", registered: false, busy: false });
  const published = renderVaultIdentityControls({ shielded, account: "0x1234", registered: true, busy: false });
  const unknown = renderVaultIdentityControls({ shielded, account: "", registered: null, busy: false });

  assert.match(unpublished, /id="register-keys"/);
  assert.match(unpublished, />PUBLISH SHIELDED ADDRESS</);
  assert.doesNotMatch(published, /id="register-keys"/);
  assert.doesNotMatch(unknown, /id="register-keys"/);
});

test("disables an unpublished address action while another operation is busy", () => {
  const html = renderVaultIdentityControls({ shielded, account: "0x1234", registered: false, busy: true });
  assert.match(html, /id="register-keys"[^>]*disabled/);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test app/src/vault-identity.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `app/src/vault-identity.js`.

- [ ] **Step 3: Implement the minimal pure renderer**

Create `app/src/vault-identity.js`:

```js
function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function short(value) {
  const text = String(value);
  return text.length > 16 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
}

export function renderVaultIdentityControls({ shielded, account, registered, busy }) {
  const { B, V } = shielded;
  const status = !account ? "CONNECT WALLET" : registered === true ? "PUBLISHED" : registered === false ? "NOT PUBLISHED" : "CHECKING";
  const spendingKey = `${B[0]}, ${B[1]}`;
  const viewingKey = `${V[0]}, ${V[1]}`;
  const publishAction = registered === false
    ? `<button id="register-keys" class="secondary-btn" ${busy ? "disabled" : ""}>PUBLISH SHIELDED ADDRESS</button>`
    : "";

  return `
    <section class="transit-identity" aria-labelledby="shielded-address-title">
      <div class="card-heading"><h2 id="shielded-address-title">SHIELDED ADDRESS</h2><span class="online"><i class="dot teal-dot"></i> ${status}</span></div>
      <p class="identity-copy">Publish your public shielded keys so senders can resolve your connected wallet and deliver shielded notes to this vault. Your private keys and recovery phrase stay local and are never published.</p>
      <div class="shielded-key-list">
        <div class="shielded-key-row"><span>SPENDING KEY</span><code>${short(B[0])} · ${short(B[1])}</code><button type="button" data-copy-shielded="${escapeHtml(spendingKey)}" data-copy-label="Spending key">COPY</button></div>
        <div class="shielded-key-row"><span>VIEWING KEY</span><code>${short(V[0])} · ${short(V[1])}</code><button type="button" data-copy-shielded="${escapeHtml(viewingKey)}" data-copy-label="Viewing key">COPY</button></div>
      </div>
      <div class="transit-identity-actions">${publishAction}<button id="reveal-mnemonic" class="secondary-btn">SHOW RECOVERY PHRASE</button></div>
    </section>`;
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test app/src/vault-identity.test.mjs
```

Expected: 3 tests pass, 0 fail.

- [ ] **Step 5: Commit the renderer and tests**

```bash
git add app/src/vault-identity.js app/src/vault-identity.test.mjs
git commit --no-gpg-sign -m "test: define vault identity controls"
```

### Task 2: Integrate identity controls into `/vault` only

**Files:**
- Modify: `app/src/main.js:1-25,215-233,524-568,830-854`
- Modify: `app/src/style.css:300-341,374-390`

**Interfaces:**
- Consumes: `renderVaultIdentityControls(options): string` from Task 1.
- Produces: `/vault` dashboard markup with `.transit-identity`; child workflow markup contains no identity or recovery controls.

- [ ] **Step 1: Add a failing static integration test for structural route scope**

Append to `app/src/vault-identity.test.mjs`:

```js
import { readFile } from "node:fs/promises";

test("integrates identity controls through homeView rather than the shared app shell", async () => {
  const source = await readFile(new URL("./main.js", import.meta.url), "utf8");
  const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
  const appShellSource = section("function appShell()", "function bind()");
  const homeViewSource = section("function homeView()", "function noteMapDestination(");

  assert.doesNotMatch(appShellSource, /renderVaultIdentityControls|vaultAddressTile/);
  assert.match(homeViewSource, /renderVaultIdentityControls/);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test app/src/vault-identity.test.mjs
```

Expected: the structural route-scope test fails because `homeView()` does not yet call `renderVaultIdentityControls` and `appShell()` still includes `vaultAddressTile()`.

- [ ] **Step 3: Move identity composition into `homeView()`**

In `app/src/main.js`, add:

```js
import { renderVaultIdentityControls } from "./vault-identity.js";
```

Remove `${vaultAddressTile()}` from `appShell()`. Delete `vaultAddressTile()`, `publishButtonLabel()`, and `identityStrip()`.

At the bottom of the Transit Map panel returned by `homeView()`, after the existing `.micro` paragraph and before the closing `</section>`, add:

```js
${renderVaultIdentityControls({
  shielded: state.identity.shielded,
  account: state.account,
  registered: state.registered,
  busy: state.busy,
})}
```

Do not change the existing bindings for `#register-keys`, `#reveal-mnemonic`, or `[data-copy-shielded]`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test app/src/vault-identity.test.mjs
```

Expected: 4 tests pass, 0 fail.

- [ ] **Step 5: Replace standalone-tile CSS with embedded-section CSS**

In `app/src/style.css`, replace `.vault-address-tile` rules with:

```css
.transit-identity{margin-top:22px;padding-top:22px;border-top:2px solid var(--ink)}
.transit-identity .card-heading h2{font-size:20px}
.transit-identity .identity-copy{max-width:760px;margin:8px 0 18px;color:#555;line-height:1.5}
.transit-identity .online{border-width:2px;padding:8px 11px;font-size:9px}
.shielded-key-list{display:flex;flex-direction:column;gap:10px}
.shielded-key-row{display:grid;grid-template-columns:112px minmax(0,1fr) 58px;gap:12px;align-items:center;min-height:48px;border:2px solid var(--ink);padding:8px 10px;background:#fbf7ed}
.shielded-key-row>span{color:#666;font:500 9px 'DM Mono';letter-spacing:1.5px}
.shielded-key-row code{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:500 11px 'DM Mono'}
.shielded-key-row button{border:1px solid var(--ink);background:var(--paper);padding:6px 8px;font:700 8px 'DM Mono';letter-spacing:1px}
.shielded-key-row button:hover{background:var(--yellow)}
.transit-identity-actions{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-top:18px;padding-top:18px;border-top:2px solid var(--ink)}
.transit-identity-actions .secondary-btn{border-width:2px;box-shadow:4px 4px 0 var(--ink);padding:13px}
.transit-identity-actions .secondary-btn:disabled{box-shadow:none;border-style:dashed;background:transparent;color:#888;cursor:not-allowed}
```

In the `max-width: 650px` block, remove `.vault-address-tile` from the shared padding selector, keep the existing mobile `.shielded-key-row` rules, and replace `.vault-address-actions{grid-template-columns:1fr}` with:

```css
.transit-identity-actions{grid-template-columns:1fr}
```

- [ ] **Step 6: Run the complete app test suite**

Run:

```bash
yarn --cwd app test:server
```

Expected: all server and source tests pass with 0 failures.

- [ ] **Step 7: Build the production client**

Run:

```bash
yarn --cwd app build
```

Expected: Vite exits 0 and writes the production bundle without syntax or import errors.

- [ ] **Step 8: Verify rendered route scope and responsive layout**

Start the app with:

```bash
yarn --cwd app dev
```

Using the browser at desktop and mobile widths, unlock a test vault and verify:

- `/vault` shows the public key rows and recovery action inside the Transit Map panel.
- The explanation says senders use the published public keys to resolve the connected wallet and deliver notes, while private/recovery material remains local.
- The publish action appears only for a definitively unpublished registry state and disappears after publication.
- `/vault/deposit`, `/vault/bridge`, `/vault/withdraw`, and `/vault/ragequit` contain no shielded-address or recovery controls.
- Long public coordinates truncate visually but their copy buttons retain the complete coordinate pair.
- At mobile width, the SVG remains horizontally navigable and the identity key/action rows do not overflow.

- [ ] **Step 9: Check the scoped diff and preserve the dirty worktree**

Run:

```bash
git diff --check -- app/src/main.js app/src/style.css app/src/vault-identity.js app/src/vault-identity.test.mjs
git diff -- app/src/main.js app/src/style.css app/src/vault-identity.js app/src/vault-identity.test.mjs
```

Expected: no whitespace errors; the diff contains only identity placement, explanatory copy, conditional publish rendering, tests, and associated styles while preserving pre-existing unrelated edits.

`app/src/main.js` and `app/src/style.css` already contain uncommitted work that predates this plan. Do not stage or commit those files automatically, because doing so would capture unrelated user changes. Leave the verified integration edits in the worktree and report that constraint in the handoff. If the user explicitly asks for an integration commit after reviewing the diff, stage only the approved hunks interactively and re-check the cached diff before committing.

For an explicitly approved commit, use:

```bash
git add -p app/src/main.js app/src/style.css
git diff --cached --check
git diff --cached -- app/src/main.js app/src/style.css
git commit --no-gpg-sign -m "feat: embed identity controls in vault transit map"
```
