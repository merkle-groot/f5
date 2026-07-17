import "./style.css";
import { createPublicClient, createWalletClient, custom, decodeAbiParameters, formatEther, http, isAddress, parseEther } from "viem";
import {
  IDENTITY_UNWRAP_MESSAGE,
  createMnemonic,
  forgetIdentity,
  hasIdentity,
  hasLegacyNotes,
  identityUnwrapKind,
  importLegacyNotes,
  loadL2History,
  loadMnemonic,
  loadNotes,
  saveL2History,
  saveMnemonic,
  saveNotes,
  validateRecoveryPhrase,
} from "./vault.js";

/**
 * The Vault — one docked panel, three roles behind one recovery phrase.
 *
 *  DEPOSIT  — put value into the L1 pool. Produces an L1 note.
 *  SEND     — spend an L1 note, bridge it, deliver C_dest to a recipient's
 *             shielded address. Needs ONLY the recipient's PUBLIC (B, V).
 *  RECEIVE  — scan the destination pool for notes addressed to you, then
 *             activate / prove / withdraw. Needs YOUR PRIVATE (b, v).
 *
 * The mnemonic derives the L1 note secrets, the shielded keys, and the vault
 * encryption key — so it is the ONLY thing a user must back up. The note cache
 * and the L2 history are a display convenience, never a spend authority.
 *
 * Layout: when locked, a single centered onboarding card. When unlocked, a
 * two-pane workspace — the active flow on the LEFT, the persistent Vault dock
 * (identity, balance, notes across L1 + each L2 incl. spent/withdrawn) on the
 * RIGHT. Forms live in the left pane so the dock stays calm and data-only.
 */

const STARKNET_CHAIN_ID = "393402133025997798000961";

const REGISTRY_ABI = [
  { type: "function", name: "registerKeys", stateMutability: "nonpayable", inputs: [{ name: "schemeId", type: "uint256" }, { name: "stealthMetaAddress", type: "bytes" }], outputs: [] },
  { type: "function", name: "stealthMetaAddressOf", stateMutability: "view", inputs: [{ name: "registrant", type: "address" }, { name: "schemeId", type: "uint256" }], outputs: [{ type: "bytes" }] },
];
const poolAbi = [{ type: "function", name: "deposit", stateMutability: "payable", inputs: [{ name: "precommitment", type: "uint256" }], outputs: [] }];

const state = {
  /** Which flow occupies the left workspace: "home" | "deposit" | "send" | "receive". */
  view: "home",
  amount: "1",
  account: "",
  config: null,
  error: null,
  notice: null,
  busy: false,

  /** { mnemonic, master, shielded, vaultKey } — derived, never persisted raw. */
  identity: null,
  /** Set while the user is being shown a freshly generated mnemonic to write down. */
  setup: null,
  unlockPassword: "",

  /** L1 deposit notes, each `{ ..., status: "ready" | "spent" }`. A cache. */
  notes: [],
  /** { [cDest]: { value, chain, recipient, hash, at } } — withdrawn L2 notes. */
  withdrawn: {},
  registered: null,

  send: { noteCommitment: "", destinationChainId: "11155420", recipientKey: "", resolved: null, draft: null },
  /** Starknet destination health. Bridging to a pool bound to a DIFFERENT L1 pool
   *  loses the funds: StarkGate delivers the ETH but `receive_note` reverts with
   *  NotL1Pool, so no note ever exists to claim it. Never offer it blind. */
  starknet: null,
  receive: { scanned: [], scannedCount: 0, index: {}, selected: null, recipient: "", status: null, activation: null, proof: null, withdrawal: null, response: null },
};

const app = document.querySelector("#app");
const sdk = () => import("@0xbow/privacy-pools-core-sdk");
const icons = {
  mark: `<img class="brand-eye" src="/f5-eye.svg" alt="" aria-hidden="true">`,
  eth: `<span class="eth">Ξ</span>`,
};

/** The configured EVM L2 destinations, advertised by the server in /api/config. */
function evmChains() { return state.config?.l2Chains ?? []; }
/** Human label for a destination chain key (an EVM key like "op"/"base", or "starknet"). */
function chainLabel(key) {
  if (key === "starknet") return "Starknet";
  return evmChains().find((c) => c.key === key)?.chainName ?? key;
}

/*//////////////////////////////////////////////////////////////
                              RENDER
//////////////////////////////////////////////////////////////*/

function render() {
  if (location.hash !== "#relay") return renderLanding();
  app.innerHTML = state.identity ? appShell() : onboardingShell();
  bind();
  if (!state.config) loadConfig();
}

/** Chrome shared by both the onboarding and unlocked states. */
function topbar() {
  const acct = state.account ? `${state.account.slice(0, 6)}…${state.account.slice(-4)}` : "CONNECT";
  return `
    <header class="topbar">
      <a class="brand" href="#"><span class="brand-mark">${icons.mark}</span><span>F5</span><span class="tag pink">VAULT</span></a>
      <div class="wallet">
        <button class="network"><i class="dot blue"></i> ${state.config?.chainName ?? "Ethereum"}</button>
        <button id="connect" class="account">${acct}</button>
        ${state.identity ? `<button id="lock" class="account">LOCK</button>` : ""}
      </div>
    </header>`;
}

function footer() {
  return `<footer><span>© 2026 F5 / SHIELDED VAULT</span><span><a href="#">Home</a></span></footer>`;
}

/** Locked: nothing but the minimal onboarding card. */
function onboardingShell() {
  return `
    ${topbar()}
    <main class="onboarding-shell">
      <section class="panel onboarding">
        <span class="sticker teal onboarding-sticker">SHIELDED ★</span>
        ${noticeView()}${errorView()}
        ${identityGate()}
      </section>
    </main>
    ${footer()}`;
}

/** Unlocked: active flow on the left, the persistent Vault dock on the right. */
function appShell() {
  const workspace = state.view === "deposit" ? depositView()
    : state.view === "send" ? sendView()
    : state.view === "receive" ? receiveView()
    : homeView();
  return `
    ${topbar()}
    <main class="app-shell">
      <section class="workspace-main">
        ${noticeView()}${errorView()}
        ${workspace}
      </section>
      ${vaultDock()}
    </main>
    ${footer()}`;
}

function bind() {
  const on = (sel, event, fn) => app.querySelector(sel)?.addEventListener(event, fn);

  app.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => {
    captureForm(); state.view = b.dataset.view; state.error = null; state.notice = null; render();
  }));
  on("#connect", "click", () => guard(connectWallet));
  on("#lock", "click", lockVault);
  on("#action", "click", submitFlow);
  on("#dismiss-error", "click", () => { state.error = null; render(); });
  on("#amount", "input", (e) => { e.target.value = sanitizeAmount(e.target.value); state.amount = e.target.value; });

  on("#create-identity", "click", startIdentitySetup);
  on("#import-identity", "click", startIdentityImport);
  on("#cancel-setup", "click", () => { state.setup = null; state.error = null; render(); });
  on("#copy-phrase", "click", () => guard(copySetupMnemonic));
  on("#confirm-setup", "click", () => guard(confirmIdentitySetup));
  on("#confirm-import", "click", () => guard(confirmImportedIdentity));
  app.querySelectorAll('input[name="setup-kind"]').forEach((input) => input.addEventListener("change", (event) => {
    if (!state.setup || !event.target.checked) return;
    state.setup.kind = event.target.value;
    render();
    if (event.target.value === "password") app.querySelector("#setup-password")?.focus();
  }));
  on("#unlock-wallet", "click", () => guard(() => unlockIdentity("wallet")));
  on("#unlock-password", "click", () => guard(() => unlockIdentity("password")));
  on("#reveal-mnemonic", "click", () => { state.notice = `Recovery phrase. Write it down:\n\n${state.identity.mnemonic}`; render(); });
  on("#register-keys", "click", () => guard(registerShieldedAddress));
  on("#recover-l1", "click", () => guard(recoverL1Notes));
  app.querySelectorAll("[data-scan]").forEach((b) => b.addEventListener("click", () => guard(scanForNotes)));
  on("#resolve-recipient", "click", () => guard(resolveRecipient));

  const wordInputs = [...app.querySelectorAll("[data-mnemonic-word]")];
  const fillImportedPhrase = (value) => {
    const words = normalizePhrase(value).split(" ").filter(Boolean);
    state.setup.words = Array.from({ length: 12 }, (_, i) => words[i] ?? "");
    wordInputs.forEach((input, i) => { input.value = state.setup.words[i]; });
    if (words.length !== 12) {
      state.error = `Paste exactly 12 words. Found ${words.length}.`;
      render();
      return;
    }
    state.error = null;
    wordInputs[11]?.focus();
  };
  wordInputs.forEach((input) => {
    input.addEventListener("input", (event) => {
      const index = Number(event.target.dataset.mnemonicWord);
      if (index === 0 && /\s/.test(event.target.value.trim())) {
        fillImportedPhrase(event.target.value);
        return;
      }
      const word = normalizeWord(event.target.value);
      event.target.value = word;
      state.setup.words[index] = word;
    });
  });
  wordInputs[0]?.addEventListener("paste", (event) => {
    const text = event.clipboardData?.getData("text") ?? "";
    if (!/\s/.test(text.trim())) return;
    event.preventDefault();
    fillImportedPhrase(text);
  });

  // Pick a READY L1 note → open SEND pre-loaded with it.
  app.querySelectorAll("[data-send-note]").forEach((el) => el.addEventListener("click", () => {
    captureForm();
    state.send.noteCommitment = el.dataset.sendNote;
    state.send.draft = null;
    state.view = "send";
    render();
  }));

  // Pick an actionable L2 note → open RECEIVE and refresh its on-chain status.
  app.querySelectorAll("[data-pick-l2]").forEach((el) => el.addEventListener("click", () => {
    captureForm();
    const r = state.receive;
    r.selected = el.dataset.pickL2;
    r.proof = null; r.activation = null; r.response = null;
    state.view = "receive";
    guard(async () => { await refreshSelectedStatus(); });
  }));
}

/** Run an async handler with uniform busy/error handling. */
async function guard(fn) {
  if (state.busy) return;
  state.busy = true;
  state.error = null;
  captureForm();

  // Paint the busy state BEFORE starting the work. Without this the flag never reaches the DOM:
  // proving runs snarkjs wasm on the main thread for tens of seconds, so the UI would sit frozen
  // and visually unchanged from the click until it finished — indistinguishable from "nothing
  // happened". The timeout yields a frame so the browser actually renders before we block it.
  render();
  await new Promise((resolve) => setTimeout(resolve, 0));

  try {
    await fn();
  } catch (error) {
    if (error?.code !== 4001) state.error = describeError(error);
  } finally {
    state.busy = false;
    render();
    // The error banner lives at the top of the workspace but actions sit at the bottom, so a
    // failure can land off-screen. Bring it into view rather than looking like a no-op.
    if (state.error) app.querySelector(".error-card")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function lockVault() {
  // Wipe only the in-memory identity + derived caches. The encrypted vault stays
  // on disk — this is a lock, not a forget.
  state.identity = null;
  state.notes = [];
  state.withdrawn = {};
  state.registered = null;
  state.view = "home";
  state.receive = { scanned: [], scannedCount: 0, index: {}, selected: null, recipient: "", status: null, activation: null, proof: null, withdrawal: null, response: null };
  state.send = { noteCommitment: "", destinationChainId: "11155420", recipientKey: "", resolved: null, draft: null };
  render();
}

function renderLanding() {
  app.innerHTML = `
    <header class="topbar landing-topbar">
      <a class="brand" href="#"><span class="brand-mark">${icons.mark}</span><span>F5</span><span class="tag pink">A NODE TO TORNADO CASH</span></a>
      <nav><a class="active teal-underline" href="#">Protocol</a><a class="pink-underline" href="#docs">Docs</a><a class="launch" href="#relay">OPEN VAULT ↗</a></nav>
    </header>
    <main class="landing">
      <section class="hero"><div class="hero-copy"><span class="sticker teal hero-sticker">★ THE HIGHEST CATEGORY ★</span><h1>BLOW AWAY<br>YOUR <span>TRAIL</span></h1><p>F5 is an independent relayer node. We broadcast your withdrawal and pay the gas, so your fresh wallet stays fresh and nothing on-chain points back at you.</p><div class="hero-actions"><a class="primary hero-primary" href="#relay">OPEN THE VAULT →</a><a class="secondary" href="#how">HOW IT WORKS</a></div><div class="node-pill"><i class="dot teal-dot"></i> NODE ONLINE</div></div><div class="hero-art"><div class="art-dots"></div><div class="trail-bars"><i class="bar blue-bar"></i><i class="bar teal-bar"></i><i class="bar yellow-bar"></i><i class="bar pink-bar"></i><i class="bar orange-bar"></i><i class="bar blue-bar short"></i><i class="bar teal-bar tiny"></i><b></b></div><span class="figure-label">FIG. 01 / CATEGORY F5</span></div></section>
      <section id="how" class="how landing-how"><span class="eyebrow teal-text">THE SIMPLE VERSION</span><h2>THREE SPINS & YOU’RE GONE <span class="blue-text">〰</span></h2><div class="steps">${step("1", "ONE PHRASE", "Twelve words derive your note secrets, your shielded address, and your vault. It is the only thing you ever back up.", "MNEMONIC ROOT", "yellow")}${step("2", "SEND BLIND", "You pay a shielded address using only its public keys. You never learn where the recipient cashes out.", "PUBLIC KEYS ONLY", "pink")}${step("3", "SCAN & LAND", "The recipient finds the note by scanning. Nobody tells them it exists, and they can withdraw anywhere.", "UNLINKABLE", "teal")}</div></section>
      <div class="ticker">NO LOGS ★ NO ADMIN KEYS ★ NON-CUSTODIAL ★ GAS PAID BY THE STORM ★ NO LOGS ★ NO ADMIN KEYS ★</div>
    </main>
    ${footer()}
  `;
}

/*//////////////////////////////////////////////////////////////
                        IDENTITY (GATE)
//////////////////////////////////////////////////////////////*/

/**
 * First interaction with any flow lands here. A user cannot deposit or withdraw
 * before they have a recovery phrase, because the phrase is what makes the
 * deposit recoverable at all.
 */
function identityGate() {
  if (state.setup?.mode === "import") {
    return `
      <div class="flow-step active phrase-head import-head"><span class="flow-number">!</span><div><span class="eyebrow">RESTORE YOUR VAULT</span><h3>IMPORT RECOVERY PHRASE</h3><p>Enter each word in order. You can also paste the entire phrase into box 1 and F5 will split it across all twelve boxes.</p></div></div>
      <div class="mnemonic-input-grid">${state.setup.words.map((word, i) => `
        <label class="mnemonic-word"><b>${i + 1}</b><input data-mnemonic-word="${i}" value="${escapeHtml(word)}" aria-label="Recovery word ${i + 1}" autocomplete="off" autocapitalize="none" spellcheck="false" /></label>`).join("")}
      </div>
      <div class="micro phrase-hint">12-word English BIP-39 phrase ★ word list and checksum checked locally</div>
      ${setupProtectionFields("confirm-import", "IMPORT MY VAULT →")}
      <div class="key-actions"><button id="cancel-setup" class="secondary-btn">← BACK</button></div>
    `;
  }

  if (state.setup) {
    return `
      <div class="flow-step active phrase-head generate-head"><span class="flow-number">!</span><div><span class="eyebrow">WRITE THIS DOWN</span><h3>YOUR RECOVERY PHRASE</h3><p>These twelve words derive your note secrets, your shielded address, and your vault. They are the only backup that exists. F5 cannot recover them for you.</p></div></div>
      <div class="mnemonic-grid">${state.setup.mnemonic.split(" ").map((w, i) => `<span><b>${i + 1}</b>${w}</span>`).join("")}</div>
      <div class="key-actions phrase-actions"><button id="cancel-setup" class="secondary-btn">← BACK</button><button id="copy-phrase" class="secondary-btn">COPY ALL 12 WORDS</button></div>
      ${setupProtectionFields("confirm-setup", "CREATE MY VAULT →", "I have written the phrase down somewhere safe.")}
      <div class="micro">the phrase never leaves this browser　★　losing it loses the funds</div>
    `;
  }

  if (hasIdentity()) {
    const kind = identityUnwrapKind();
    return `
      <div class="flow-step active"><span class="flow-number">01</span><div><span class="eyebrow">WELCOME BACK</span><h3>UNLOCK YOUR VAULT</h3><p>Your recovery phrase is stored encrypted on this device.</p></div></div>
      ${kind === "password"
        ? `<label class="input-label">PASSWORD<input id="unlock-password-input" type="password" placeholder="your vault password" value="${escapeHtml(state.unlockPassword)}" /></label>
           <button id="unlock-password" class="primary">UNLOCK →</button>`
        : `<button id="unlock-wallet" class="primary">SIGN TO UNLOCK →</button>`}
      <div class="key-actions"><button id="import-identity" class="secondary-btn">IMPORT A DIFFERENT PHRASE</button></div>
      <div class="micro">the signature only unwraps the phrase　★　it is never the key itself</div>
    `;
  }

  return `
    <div class="flow-step active"><span class="flow-number">01</span><div><span class="eyebrow">FIRST TIME HERE</span><h3>CREATE A SHIELDED VAULT</h3><p>One recovery phrase derives your L1 note secrets, your shielded address <code>(B, V)</code>, and your local vault key.</p></div></div>
    <button id="create-identity" class="primary">GENERATE RECOVERY PHRASE →</button>
    <div class="key-actions"><button id="import-identity" class="secondary-btn">I ALREADY HAVE A PHRASE</button></div>
    <div class="micro">nothing is derived from your wallet signature</div>
  `;
}

function setupProtectionFields(buttonId, buttonLabel, confirmation) {
  const kind = state.setup?.kind ?? "wallet";
  const password = state.setup?.password ?? "";
  return `
    <fieldset class="protection-choice">
      <legend>PROTECT IT ON THIS DEVICE WITH</legend>
      <label class="protection-option"><input type="radio" name="setup-kind" value="wallet" ${kind === "wallet" ? "checked" : ""} /><span><b>WALLET SIGNATURE</b><small>One click, needs an EOA</small></span></label>
      <label class="protection-option"><input type="radio" name="setup-kind" value="password" ${kind === "password" ? "checked" : ""} /><span><b>PASSWORD</b><small>Works with no wallet at all</small></span></label>
    </fieldset>
    ${kind === "password" ? `<label class="input-label" id="setup-password-row">PASSWORD<input id="setup-password" type="password" placeholder="at least 8 characters" value="${escapeHtml(password)}" /></label>` : ""}
    ${confirmation ? `<label class="confirm-row"><input type="checkbox" id="setup-confirmed" ${state.setup?.confirmed ? "checked" : ""} /> ${confirmation}</label>` : ""}
    <button id="${buttonId}" class="primary">${buttonLabel}</button>`;
}

/*//////////////////////////////////////////////////////////////
                          VAULT DOCK
//////////////////////////////////////////////////////////////*/

/** The persistent right-hand panel: identity, balance, actions, and all notes. */
function vaultDock() {
  return `
    <aside class="vault">
      ${identityStrip()}
      ${balanceCard()}
      <div class="vault-actions">
        <button class="primary" data-view="deposit">DEPOSIT</button>
        <button class="secondary-btn" data-view="send">SEND</button>
        <button class="secondary-btn" data-view="receive">RECEIVE</button>
      </div>
      ${notesSection()}
    </aside>`;
}

/** The published half of the identity, plus its ERC-6538 registration state. */
function identityStrip() {
  const { B, V } = state.identity.shielded;
  const status = state.registered === true ? "PUBLISHED" : "LOCAL";
  return `
    <section class="identity-strip">
      <div class="card-heading"><h2>YOUR ADDRESS</h2><span class="online"><i class="dot teal-dot"></i> ${status}</span></div>
      <div class="meta-address"><b>B</b> ${short(B[0].toString())}, ${short(B[1].toString())}<br><b>V</b> ${short(V[0].toString())}, ${short(V[1].toString())}</div>
      <div class="key-actions">
        <button id="register-keys" class="secondary-btn">${state.registered === true ? "RE-PUBLISH" : "PUBLISH"}</button>
        <button id="reveal-mnemonic" class="secondary-btn">SHOW PHRASE</button>
      </div>
    </section>`;
}

/** One number: spendable now, with pending + withdrawn as context. */
function balanceCard() {
  const b = balances();
  return `
    <section class="balance-card">
      <span class="eyebrow">SPENDABLE</span>
      <div class="big-balance">${fmt(b.spendable)} <small>ETH</small></div>
      <div class="balance-sub">
        <span><b>${fmt(b.pending)}</b> pending</span>
        <span><b>${fmt(b.withdrawn)}</b> withdrawn</span>
      </div>
    </section>`;
}

/** All notes, grouped by where they live. Spent/withdrawn are shown as history. */
function notesSection() {
  const l1Ready = state.notes.filter((n) => n.status !== "spent");
  const l1Spent = state.notes.filter((n) => n.status === "spent");
  return `
    <section class="notes-section">
      <div class="group-heading"><h3>L1 · ETHEREUM</h3><button id="recover-l1" class="unlock">RECOVER</button></div>
      ${l1Ready.length || l1Spent.length
        ? [...l1Ready, ...l1Spent].map(l1NoteRow).join("")
        : `<div class="note-empty">No L1 notes.<br><span>Deposit, or hit RECOVER to rebuild from your phrase.</span></div>`}

      ${evmChains().map((c, i) => `
        <div class="group-heading"><h3>L2 · ${escapeHtml(c.chainName)}</h3>${i === 0 ? `<button data-scan class="unlock">SCAN</button>` : ""}</div>
        ${l2Group(c.key)}`).join("")}

      ${state.starknet?.configured || l2List("starknet").length ? `
        <div class="group-heading"><h3>L2 · STARKNET</h3>${evmChains().length === 0 ? `<button data-scan class="unlock">SCAN</button>` : ""}</div>
        ${l2Group("starknet")}` : ""}
    </section>`;
}

function l1NoteRow(n) {
  const spent = n.status === "spent";
  const attr = spent ? "" : `data-send-note="${n.commitment}" role="button" tabindex="0"`;
  return `
    <div class="vnote ${spent ? "is-past" : ""}" ${attr}>
      <span class="note-icon">${icons.eth}</span>
      <div><strong>${formatEther(BigInt(n.value))} ETH</strong><small>${n.legacy ? "legacy" : `#${n.index}`}　·　${short(n.commitment)}</small></div>
      ${pill(spent ? "spent" : "ready")}
    </div>`;
}

function l2Group(chain) {
  const list = l2List(chain);
  if (!list.length) {
    const scanned = state.receive.scannedCount > 0;
    return `<div class="note-empty">${scanned ? "Nothing addressed to you here." : "Hit SCAN to search for notes."}</div>`;
  }
  return list.map((x) => {
    const actionable = x.status === "spendable" || x.status === "activate";
    const attr = actionable ? `data-pick-l2="${x.id}" role="button" tabindex="0"` : "";
    return `
      <div class="vnote ${x.status === "withdrawn" ? "is-past" : ""}" ${attr}>
        <span class="note-icon">${icons.eth}</span>
        <div><strong>${formatEther(BigInt(x.value))} ETH</strong><small>${short(x.id)}</small></div>
        ${pill(x.status)}
      </div>`;
  }).join("");
}

const PILL = {
  ready: ["READY", "ok"],
  spendable: ["SPENDABLE", "ok"],
  activate: ["ACTIVATE", "warn"],
  pending: ["PENDING", "warn"],
  withdrawn: ["WITHDRAWN ✓", "past"],
  spent: ["SPENT →", "past"],
};
function pill(status) {
  const [label, cls] = PILL[status] ?? ["?", "warn"];
  return `<span class="pill ${cls}">${label}</span>`;
}

/*//////////////////////////////////////////////////////////////
                        WORKSPACE VIEWS
//////////////////////////////////////////////////////////////*/

function flowHead(eyebrow, title, sub) {
  return `<div class="flow-head"><div><span class="eyebrow">${eyebrow}</span><h2>${title}</h2><p>${sub}</p></div><button class="ghost" data-view="home">← HOME</button></div>`;
}

/** Default left pane: a chain map showing where the user's current notes live. */
function homeView() {
  const b = balances();
  const l1Notes = state.notes.filter((note) => note.status !== "spent");
  const l1Total = l1Notes.reduce((sum, note) => sum + BigInt(note.value), 0n);
  const destinations = evmChains().map((chain) => noteMapDestination(chain.key, chain.chainName));
  if (state.starknet?.configured || l2List("starknet").length) {
    destinations.push(noteMapDestination("starknet", "Starknet"));
  }
  const totalShielded = b.spendable + b.pending;
  return `
    <section class="panel home-panel">
      <div class="map-heading">
        <div><span class="eyebrow">WHERE YOUR NOTES LIVE</span><h2>NOTE MAP</h2></div>
        <div class="map-total"><span>TOTAL SHIELDED</span><strong>${fmt(totalShielded)} <small>ETH</small></strong></div>
      </div>
      <div class="note-map">
        <article class="map-chain map-source ${l1Total > 0n ? "has-value" : "is-empty"}">
          <div class="map-chain-total">${fmt(l1Total)} <small>ETH</small></div>
          <div class="map-chain-card">
            <span class="map-chain-icon">Ξ</span>
            <div><b>ETHEREUM</b><small>${l1Notes.length} ready note${l1Notes.length === 1 ? "" : "s"}</small></div>
          </div>
        </article>
        <div class="map-relay" aria-label="F5 Vault routing point">
          <span class="map-relay-eye"><img src="/f5-eye.svg" alt="" aria-hidden="true" /></span>
          <b>F5 VAULT</b>
        </div>
        <div class="map-destinations">
          ${destinations.length ? destinations.join("") : `<div class="map-empty">No L2 destinations configured.</div>`}
        </div>
      </div>
      <div class="map-legend">
        <span><i class="legend-dot available"></i> AVAILABLE</span>
        <span><i class="legend-dot pending"></i> PENDING ACTIVATION</span>
        <span><i class="legend-dot empty"></i> NO NOTES</span>
      </div>
      <div class="home-actions">
        <button class="primary" data-view="deposit">DEPOSIT →</button>
        <button class="secondary-btn" data-view="send">SEND</button>
        <button class="secondary-btn" data-view="receive">RECEIVE</button>
      </div>
      <p class="micro">current shielded notes only ★ spent and withdrawn history is not counted</p>
    </section>`;
}

function noteMapDestination(key, label) {
  const notes = l2List(key).filter((note) => note.status !== "withdrawn");
  let available = 0n;
  let pending = 0n;
  for (const note of notes) {
    if (note.status === "spendable") available += BigInt(note.value);
    else if (note.status === "activate" || note.status === "pending") pending += BigInt(note.value);
  }
  const total = available + pending;
  const stateClass = available > 0n ? "has-value" : pending > 0n ? "has-pending" : "is-empty";
  const initials = key === "starknet" ? "SN" : label.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  return `
    <article class="map-chain map-destination ${stateClass}">
      <div class="map-chain-total">${fmt(total)} <small>ETH</small></div>
      <div class="map-chain-card">
        <span class="map-chain-icon">${escapeHtml(initials)}</span>
        <div><b>${escapeHtml(label)}</b><small>${fmt(available)} available · ${fmt(pending)} pending · ${notes.length} note${notes.length === 1 ? "" : "s"}</small></div>
      </div>
    </article>`;
}

function depositView() {
  const config = state.config;
  const minimum = config?.minDepositWei && config.minDepositWei !== "0" ? `${formatEther(BigInt(config.minDepositWei))} ${config.symbol}` : "not available";
  return `
    <section class="panel flow-panel">
      ${flowHead("L1 · ETHEREUM", "DEPOSIT", "Put value into the pool. The note's secrets come from your phrase, so it survives a wiped browser.")}
      <div class="field-label"><span>FROM</span><span><i class="dot blue"></i> ${config?.chainName ?? "LOADING"}</span></div>
      <div class="amount-field"><div><input id="amount" value="${sanitizeAmount(state.amount)}" inputmode="decimal" autocomplete="off" /><small>Any amount · minimum ${minimum}</small></div><button class="asset">${icons.eth} ${config?.symbol ?? "ETH"}</button></div>
      <div class="field-label pool-label"><span>VARIABLE AMOUNT</span><span>${config ? `${config.vettingFeeBps / 100}% VETTING FEE` : "LOADING"}</span></div>
      <button id="action" class="primary" ${state.busy ? "disabled" : ""}>${state.busy ? "DEPOSITING… CONFIRM IN YOUR WALLET" : "DEPOSIT TO POOL →"}</button>
      <div class="micro">derived at the next unused index　★　non-custodial</div>
    </section>`;
}

/**
 * SEND. Only ever handles the recipient's PUBLIC keys — there is deliberately no
 * field for their private keys, and none for their final L2 address. The sender
 * is entitled to neither, and `RelayData.recipient` is emitted publicly on L1,
 * so putting the recipient's exit address there would link the L1 relay to the
 * L2 cash-out in the clear.
 */
function sendView() {
  const send = state.send;
  const draft = send.draft;
  const ready = state.notes.filter((n) => n.status !== "spent");
  const selected = pickNote();
  const chainOption = (v, l) => `<option value="${v}" ${send.destinationChainId === v ? "selected" : ""}>${l}</option>`;
  const noteOption = (n) => `<option value="${n.commitment}" ${selected?.commitment === n.commitment ? "selected" : ""}>${formatEther(BigInt(n.value))} ETH · ${short(n.commitment)}</option>`;
  // Proving is a long, main-thread-blocking wasm run — say so, or the button looks dead.
  const action = state.busy
    ? (draft?.proof ? "SUBMITTING RELAY…" : "PROVING… THIS CAN TAKE A MINUTE")
    : draft?.relayed ? "RELAY SUBMITTED ✓" : draft?.proof ? "SUBMIT L1 RELAY →" : "QUOTE & PROVE →";

  return `
    <section class="panel flow-panel">
      ${flowHead("L1 · ETHEREUM", "SEND A NOTE", ready.length ? "Spend an L1 note and deliver it to a shielded address." : "No spendable L1 notes. Deposit, or hit RECOVER.")}
      <label class="input-label">L1 NOTE TO SPEND<select id="send-note">${ready.length ? ready.map(noteOption).join("") : `<option value="">No notes</option>`}</select></label>
      <label class="input-label">BRIDGE TARGET<select id="send-chain">${evmChains().map((c) => chainOption(String(c.chainId), c.chainName)).join("")}${starknetOption()}</select></label>
      ${starknetWarning()}
      <label class="input-label">RECIPIENT
        <input id="send-recipient" placeholder="0x… their address (from the registry), or paste Bx,By,Vx,Vy" value="${escapeHtml(send.recipientKey)}" />
      </label>
      <div class="key-actions"><button id="resolve-recipient" class="secondary-btn">RESOLVE FROM REGISTRY</button></div>
      ${send.resolved ? `<div class="notice teal-card"><strong>RECIPIENT RESOLVED</strong><span>B ${short(send.resolved.B[0].toString())}…<br>V ${short(send.resolved.V[0].toString())}…</span></div>` : ""}
      <div class="notice ${draft?.relayed ? "teal-card" : "pink-card"}">
        <strong>${draft?.relayed ? "DELIVERED" : draft?.proof ? "PROOF READY" : "PUBLIC KEYS ONLY"}</strong>
        <span>${draft?.relayed
          ? "The note is bridging. The recipient finds it by scanning. You send them nothing, and you can close this tab."
          : draft?.proof
            ? `C_dest ${short(draft.destNote.cDest.toString())} · bridging ${formatEther(draft.bridgedValue)} ETH after the relay fee.`
            : "You never hold the recipient's private keys, and you don't choose where they cash out. Only they can."}</span>
      </div>
      <button id="action" class="primary" ${ready.length && !draft?.relayed && !state.busy ? "" : "disabled"}>${action}</button>
      <div class="micro">sender needs only (B, V)　★　self-bridge = send to your own address</div>
    </section>`;
}

/** RECEIVE. Keys are derived from the mnemonic — never typed. */
function receiveView() {
  const r = state.receive;
  const note = selectedNote();
  const st = r.status?.state;
  const action = state.busy
    ? (r.proof ? "SUBMITTING WITHDRAWAL…" : st === "activated" ? "PROVING… THIS CAN TAKE A MINUTE" : "WORKING…")
    : r.response ? "WITHDRAWN ✓"
    : r.proof ? "SUBMIT L2 WITHDRAWAL →"
    : st === "activated" ? "GENERATE L2 PROOF →"
    : st === "received-pending-activation" ? "ACTIVATE NOTE →"
    : note ? "REFRESH STATUS →"
    : "SELECT A NOTE";

  return `
    <section class="panel flow-panel">
      ${flowHead("L2 · DESTINATION", "RECEIVE & WITHDRAW", "Scan the destination feed for notes addressed to you, then land one to any address.")}
      <div class="notice pink-card"><strong>${r.scannedCount ? `SCANNED ${r.scannedCount} NOTE${r.scannedCount === 1 ? "" : "S"}` : "NOT SCANNED YET"}</strong><span>${r.scanned.length ? `${r.scanned.length} addressed to you. Pick one from the Vault.` : "Everything is fetched and matched in this browser; the relayer never learns which note is yours."}</span></div>
      <div class="key-actions"><button data-scan class="secondary-btn">SCAN NOW</button></div>
      ${note ? `
        <div class="flow-step active"><span class="flow-number">▸</span><div><span class="eyebrow">SELECTED</span><h3>${formatEther(note.value)} ETH · ${chainLabel(note.chain)}</h3><p>${statusLabel(st)}</p></div></div>
        <label class="input-label">FINAL RECIPIENT ${note.chain === "starknet" ? "(STARKNET FELT252)" : "ADDRESS"}<input id="recv-recipient" placeholder="${note.chain === "starknet" ? "0x… or decimal felt252" : "0x… where the funds actually land"}" value="${escapeHtml(r.recipient)}" /></label>`
        : `<div class="note-empty">Pick a note from the Vault to withdraw it.</div>`}
      <div class="notice ${r.response ? "teal-card" : "pink-card"}">
        <strong>${r.response ? "FUNDS RELEASED" : r.proof ? "L2 PROOF READY" : r.activation ? "ACTIVATION SUBMITTED" : "TWO STEPS, ONE NOTE"}</strong>
        <span>${r.response ? "The destination pool released the note to your address."
          : r.proof ? "Proved locally. F5 submits the final withdrawal and pays the gas."
          : "A bridged note must be backed by arrived tokens before it can be activated, then proven, then withdrawn."}</span>
      </div>
      <button id="action" class="primary" ${note && !r.response && !state.busy ? "" : "disabled"}>${action}</button>
      <div class="micro">keys derived from your phrase　★　notes are found, not announced</div>
    </section>`;
}

/*//////////////////////////////////////////////////////////////
                        SHARED VIEW BITS
//////////////////////////////////////////////////////////////*/

function errorView() {
  if (!state.error) return "";
  return `<div class="notice error-card" role="alert"><strong>SOMETHING BROKE</strong><span>${escapeHtml(state.error)}</span><button id="dismiss-error" class="dismiss">DISMISS</button></div>`;
}
function noticeView() {
  if (!state.notice) return "";
  return `<div class="notice teal-card" role="status"><strong>NOTED</strong><span class="pre">${escapeHtml(state.notice)}</span></div>`;
}

/**
 * Starknet is only offered when the destination pool is actually bound to OUR L1
 * pool. Otherwise selecting it would bridge real value into a pool whose
 * `receive_note` rejects the message — the ETH lands, the note never does, and
 * nothing can claim it. A disabled option is far better than a lost deposit.
 */
function starknetOption() {
  const sn = state.starknet;
  const usable = sn?.configured === true;
  const selected = state.send.destinationChainId === STARKNET_CHAIN_ID && usable;
  return `<option value="${STARKNET_CHAIN_ID}" ${usable ? "" : "disabled"} ${selected ? "selected" : ""}>Starknet Sepolia${usable ? "" : " (unavailable)"}</option>`;
}

function starknetWarning() {
  const sn = state.starknet;
  if (!sn || sn.configured) return "";
  const reason = sn.l1PoolMatches === false
    ? `The Starknet pool only accepts notes from L1 pool <b>${escapeHtml(sn.boundL1Pool ?? "?")}</b>, but this app relays from <b>${escapeHtml(sn.ourL1Pool ?? "?")}</b>. Bridging anyway would deliver the ETH and then reject the note. The value would arrive with nothing able to claim it. Its <code>l1_pool</code> is immutable, so the Cairo pool must be redeployed against this L1 pool.`
    : sn.relayerReady === false
      ? "The Starknet relayer keys are not configured on this server."
      : "The Starknet destination is unreachable.";
  return `<div class="notice error-card"><strong>STARKNET DISABLED</strong><span>${reason}</span></div>`;
}

function statusLabel(st) {
  return st === "activated" ? "activated · ready to prove"
    : st === "received-pending-activation" ? "bridged · needs activation"
    : st === "bridge-pending" ? "waiting for the bridge"
    : "checking status…";
}

function step(number, title, body, foot, color) {
  return `<article class="step ${color}"><span class="number">${number}</span><h3>${title}</h3><p>${body}</p><small>→ ${foot}</small></article>`;
}

/*//////////////////////////////////////////////////////////////
                    PORTFOLIO / BALANCE MATH
//////////////////////////////////////////////////////////////*/

/**
 * Combined per-chain L2 list: scanned notes (live) merged with the persisted
 * withdrawn set, deduped by `C_dest`. Withdrawn notes surface even before a scan,
 * and a scanned note that we know we already spent is shown as withdrawn.
 */
function l2List(chain) {
  const out = [];
  const seen = new Set();
  for (const n of state.receive.scanned) {
    if (n.chain !== chain) continue;
    const id = String(n.cDest);
    seen.add(id);
    out.push({ id, value: n.value.toString(), status: state.withdrawn[id] ? "withdrawn" : (n._status ?? "activate") });
  }
  for (const [id, w] of Object.entries(state.withdrawn)) {
    if (w.chain !== chain || seen.has(id)) continue;
    out.push({ id, value: String(w.value), status: "withdrawn" });
  }
  return out;
}

/** Everything the header numbers are made of, in wei, formatted at the edge. */
function balances() {
  let spendable = 0n;
  let pending = 0n;
  let withdrawn = 0n;

  for (const n of state.notes) {
    if (n.status !== "spent") spendable += BigInt(n.value);
  }
  for (const chain of [...evmChains().map((c) => c.key), "starknet"]) {
    for (const x of l2List(chain)) {
      if (x.status === "spendable") spendable += BigInt(x.value);
      else if (x.status === "activate" || x.status === "pending") pending += BigInt(x.value);
      else if (x.status === "withdrawn") withdrawn += BigInt(x.value);
    }
  }
  return { spendable, pending, withdrawn };
}

/** L2 status from the already-fetched scan index — no extra network calls. */
function deriveL2Status(note, index) {
  if (state.withdrawn[String(note.cDest)]) return "withdrawn";
  const hit = (index?.proofs ?? []).find((p) => String(p.commitment) === String(note.cDest));
  if (hit && Number(hit.index) >= 0) return "spendable";
  return "activate";
}

/*//////////////////////////////////////////////////////////////
                        HELPERS / STATE
//////////////////////////////////////////////////////////////*/

function captureForm() {
  const read = (id) => app.querySelector(id)?.value;
  const set = (obj, key, value) => { if (value !== undefined) obj[key] = value; };
  set(state.send, "noteCommitment", read("#send-note"));
  set(state.send, "destinationChainId", read("#send-chain"));
  set(state.send, "recipientKey", read("#send-recipient"));
  set(state.receive, "recipient", read("#recv-recipient"));
  set(state, "unlockPassword", read("#unlock-password-input"));
  if (state.setup) {
    set(state.setup, "kind", app.querySelector('input[name="setup-kind"]:checked')?.value);
    set(state.setup, "password", read("#setup-password"));
    const confirmed = app.querySelector("#setup-confirmed");
    if (confirmed) state.setup.confirmed = confirmed.checked;
    app.querySelectorAll("[data-mnemonic-word]").forEach((input) => {
      state.setup.words[Number(input.dataset.mnemonicWord)] = normalizeWord(input.value);
    });
  }
}

function normalizePhrase(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeWord(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * Human-readable failure text.
 *
 * SDKError wraps the real cause: `throw ProofError.generationFailed({ error: <the actual message> })`
 * — so `error.message` is only ever the generic wrapper ("Failed to generate proof") and the useful
 * part sits in `details`. Reading just `.message` makes every SDK failure look identical and
 * undebuggable, so unwrap `details` here.
 */
function describeError(error) {
  if (!(error instanceof Error)) return String(error);
  const details = error.details;
  if (details && typeof details === "object") {
    const inner = Object.values(details).filter((v) => typeof v === "string" && v && v !== error.message);
    if (inner.length) return `${error.message}: ${inner.join(" · ")}`;
  }
  return error.message;
}

/**
 * JSON request body that tolerates bigints.
 *
 * `JSON.stringify` THROWS on a bigint ("Do not know how to serialize a BigInt") rather than
 * coercing it, and this app's values are full of them (chainIds, commitments, values). Every API
 * that receives them parses strings back into bigints anyway — the relayer's `zNonNegativeBigInt`
 * is `z.string().or(z.number()).pipe(z.coerce.bigint())` — so stringifying at the wire boundary is
 * the expected shape, not a workaround. The server already does the mirror image of this in
 * `sendJson`; the client needs it too.
 */
function jsonBody(value) {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v));
}

function escapeHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function short(v) { const s = String(v); return s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s; }
/** Format a wei bigint down to a compact ETH string for the header numbers. */
function fmt(wei) {
  const s = formatEther(wei);
  if (!s.includes(".")) return s;
  const [whole, frac] = s.split(".");
  return `${whole}.${frac.slice(0, 4).replace(/0+$/, "") || "0"}`;
}
function sanitizeAmount(v) {
  const s = String(v ?? "").replace(/[^0-9.]/g, "");
  const [whole, ...rest] = s.split(".");
  return rest.length ? `${whole || "0"}.${rest.join("")}` : whole;
}
function randomField() {
  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  return BigInt(`0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`);
}
function pickNote() {
  const ready = state.notes.filter((n) => n.status !== "spent");
  return ready.find((n) => n.commitment === state.send.noteCommitment) ?? ready[0];
}
/**
 * Commitments are bigints in the SDK but strings once they round-trip through a
 * `data-` attribute, so a raw `===` between them is always false.
 */
function selectedNote() {
  const sel = state.receive.selected;
  if (sel === null || sel === undefined) return undefined;
  return state.receive.scanned.find((n) => String(n.cDest) === String(sel));
}

const RELAY_DATA_ABI = [{
  type: "tuple",
  components: [
    { name: "recipient", type: "address" },
    { name: "feeRecipient", type: "address" },
    { name: "ephemeralKey", type: "uint256[2]" },
    { name: "viewTag", type: "bytes1" },
    { name: "relayFeeBPS", type: "uint256" },
  ],
}];
const decodeRelayData = (data) => decodeAbiParameters(RELAY_DATA_ABI, data)[0];

function l1Chain() {
  const c = state.config;
  return { id: c.chainId, name: c.chainName, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [c.rpcUrl] } } };
}
function readClient() {
  return createPublicClient({ chain: l1Chain(), transport: state.config?.rpcUrl ? http(state.config.rpcUrl) : custom(window.ethereum) });
}
async function walletClient() {
  if (!window.ethereum) throw new Error("Connect an Ethereum wallet first.");
  if (!state.account) await connectWallet();
  return createWalletClient({ account: state.account, chain: l1Chain(), transport: custom(window.ethereum) });
}

async function connectWallet() {
  if (!window.ethereum) throw new Error("Install an Ethereum wallet to continue.");
  const [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
  state.account = account;
}

async function signIdentityMessage() {
  const wallet = await walletClient();
  return wallet.signMessage({ account: state.account, message: IDENTITY_UNWRAP_MESSAGE });
}

/*//////////////////////////////////////////////////////////////
                        IDENTITY ACTIONS
//////////////////////////////////////////////////////////////*/

function startIdentitySetup() {
  state.setup = { mode: "generate", mnemonic: createMnemonic(), kind: "wallet", password: "", confirmed: false };
  state.error = null;
  render();
}

function startIdentityImport() {
  state.setup = { mode: "import", words: Array(12).fill(""), kind: "wallet", password: "", confirmed: false };
  state.identity = null;
  state.error = null;
  render();
}

async function copySetupMnemonic() {
  const mnemonic = state.setup?.mnemonic;
  if (!mnemonic) throw new Error("Generate a recovery phrase first.");
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(mnemonic);
  } else {
    const textarea = document.createElement("textarea");
    textarea.value = mnemonic;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error("Could not copy the recovery phrase. Select the words and copy them manually.");
  }
  state.notice = "Recovery phrase copied. Store it somewhere safe and clear it from your clipboard when finished.";
}

async function confirmIdentitySetup() {
  await completeIdentitySetup(
    state.setup.mnemonic,
    "Vault created. Your phrase is the only backup. F5 cannot recover it.",
    "Confirm you have written the recovery phrase down first.",
  );
}

async function confirmImportedIdentity() {
  const mnemonic = validateRecoveryPhrase(state.setup.words.join(" "));
  await completeIdentitySetup(
    mnemonic,
    "Vault imported. Your phrase is now protected on this device.",
  );
}

async function completeIdentitySetup(mnemonic, notice, confirmationError) {
  if (confirmationError && !state.setup.confirmed) {
    throw new Error(confirmationError);
  }
  const kind = state.setup.kind ?? "wallet";

  if (kind === "password") {
    const password = state.setup.password ?? "";
    if (password.length < 8) throw new Error("Use a password of at least 8 characters.");
    await saveMnemonic(mnemonic, { kind: "password", password });
  } else {
    await saveMnemonic(mnemonic, { kind: "wallet", signature: await signIdentityMessage() });
  }

  await adoptMnemonic(mnemonic);
  state.setup = null;
  state.notice = notice;
  await afterUnlock();
}

async function unlockIdentity(kind) {
  const unwrap = kind === "password"
    ? { kind: "password", password: state.unlockPassword }
    : { kind: "wallet", signature: await signIdentityMessage() };
  await adoptMnemonic(await loadMnemonic(unwrap));
  state.unlockPassword = "";
  await afterUnlock();
}

/** Derive everything from the mnemonic. This is the only place keys come from. */
async function adoptMnemonic(mnemonic) {
  const { generateMasterKeys, generateShieldedKeys, generateVaultKey } = await sdk();
  state.identity = {
    mnemonic,
    master: generateMasterKeys(mnemonic),
    shielded: generateShieldedKeys(mnemonic),
    vaultKey: generateVaultKey(mnemonic),
  };
}

async function afterUnlock() {
  // The caches are scoped to a pool, so the config must be loaded before they can be read — an
  // unlock that raced the config would otherwise look like "no notes".
  if (!state.config) await loadConfig();
  const scope = state.config?.scope;

  // Normalise cached notes so a note written before `status` existed reads as ready.
  state.notes = (await loadNotes(state.identity.vaultKey, scope)).map((n) => ({ status: "ready", ...n }));
  state.withdrawn = await loadL2History(state.identity.vaultKey, scope);

  // Notes written before the mnemonic existed used pure local entropy, so they
  // are NOT re-derivable — migrate them into the vault or they are stranded.
  if (hasLegacyNotes() && state.account) {
    try {
      const wallet = await walletClient();
      const legacy = await importLegacyNotes(
        (message) => wallet.signMessage({ account: state.account, message }),
        state.account,
      );
      const fresh = legacy.filter((n) => !state.notes.some((k) => k.commitment === n.commitment));
      if (fresh.length) {
        state.notes = [...state.notes, ...fresh.map((n) => ({ status: "ready", ...n }))];
        await saveNotes(state.identity.vaultKey, state.config.scope, state.notes);
        state.notice = `Migrated ${fresh.length} legacy note${fresh.length === 1 ? "" : "s"} into the new vault.`;
      }
    } catch { /* Legacy migration is best-effort; never block the unlock. */ }
  }

  await checkRegistration();
}

/*//////////////////////////////////////////////////////////////
                       ERC-6538 REGISTRY
//////////////////////////////////////////////////////////////*/

async function checkRegistration() {
  if (!state.identity || !state.account || !state.config?.rpcUrl) return;
  try {
    const { SHIELDED_SCHEME_ID, ERC6538_REGISTRY, encodeShieldedMetaAddress } = await sdk();
    const stored = await readClient().readContract({
      address: ERC6538_REGISTRY, abi: REGISTRY_ABI, functionName: "stealthMetaAddressOf",
      args: [state.account, SHIELDED_SCHEME_ID],
    });
    const mine = encodeShieldedMetaAddress(state.identity.shielded);
    state.registered = stored?.toLowerCase() === mine.toLowerCase();
  } catch {
    state.registered = null;
  }
}

/**
 * Publish (B, V) to the canonical ERC-6538 registry.
 *
 * NOT under schemeId 1 — that is secp256k1, and a conformant ERC-5564 wallet
 * reading our Baby Jubjub blob as secp256k1 keys would derive a garbage address
 * and send real funds to it. The SDK's domain-separated schemeId keeps
 * conformant tooling correctly ignoring us.
 */
async function registerShieldedAddress() {
  if (!state.identity) throw new Error("Unlock your vault first.");
  const { SHIELDED_SCHEME_ID, ERC6538_REGISTRY, encodeShieldedMetaAddress } = await sdk();
  const wallet = await walletClient();
  const hash = await wallet.writeContract({
    address: ERC6538_REGISTRY,
    abi: REGISTRY_ABI,
    functionName: "registerKeys",
    args: [SHIELDED_SCHEME_ID, encodeShieldedMetaAddress(state.identity.shielded)],
  });
  await readClient().waitForTransactionReceipt({ hash });
  state.registered = true;
  state.notice = "Shielded address published. Senders can now resolve it from your address.";
}

/** Accept either a raw `Bx,By,Vx,Vy` blob or an EOA to look up in the registry. */
async function resolveRecipient() {
  const input = (state.send.recipientKey ?? "").trim();
  if (!input) throw new Error("Enter the recipient's address or their shielded keys.");
  const { SHIELDED_SCHEME_ID, ERC6538_REGISTRY, decodeShieldedMetaAddress } = await sdk();

  if (isAddress(input)) {
    const stored = await readClient().readContract({
      address: ERC6538_REGISTRY, abi: REGISTRY_ABI, functionName: "stealthMetaAddressOf",
      args: [input, SHIELDED_SCHEME_ID],
    });
    if (!stored || stored === "0x") {
      throw new Error("That address has not published a shielded address to the registry.");
    }
    state.send.resolved = decodeShieldedMetaAddress(stored);
    return;
  }

  const parts = input.split(",").map((p) => p.trim());
  if (parts.length !== 4 || !parts.every((p) => /^\d+$/.test(p))) {
    throw new Error("Paste four comma-separated field elements (Bx,By,Vx,Vy) or an 0x address to resolve.");
  }
  state.send.resolved = { B: [BigInt(parts[0]), BigInt(parts[1])], V: [BigInt(parts[2]), BigInt(parts[3])] };
}

/*//////////////////////////////////////////////////////////////
                        NOTES / SCANNING
//////////////////////////////////////////////////////////////*/

/** Rebuild L1 notes from the mnemonic + public deposit events. No local state. */
async function recoverL1Notes() {
  if (!state.identity) throw new Error("Unlock your vault first.");
  if (!state.config?.scope) throw new Error("POOL_SCOPE is not configured on the API.");

  const response = await fetch("/api/l1/deposits");
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Unable to index deposits.");

  const { recoverNotes } = await sdk();
  const deposits = (body.deposits ?? []).map((d) => ({
    commitment: BigInt(d.commitment), label: BigInt(d.label),
    value: BigInt(d.value), precommitment: BigInt(d.precommitment),
  }));

  // Preserve any local `spent` flag: recovery walks public deposits and cannot
  // tell a spent note from a live one, so a rebuild must not resurrect history.
  const prev = new Map(state.notes.map((n) => [n.commitment, n.status]));
  const recovered = recoverNotes(state.identity.mnemonic, BigInt(state.config.scope), deposits).map((n) => ({
    index: n.index.toString(),
    commitment: n.commitment.toString(),
    label: n.label.toString(),
    value: n.value.toString(),
    nullifier: n.nullifier.toString(),
    secret: n.secret.toString(),
    status: prev.get(n.commitment.toString()) ?? "ready",
  }));

  // Keep legacy (non-derivable) notes; they can never be recovered this way.
  const legacy = state.notes.filter((n) => n.legacy);
  state.notes = [...recovered, ...legacy];
  await saveNotes(state.identity.vaultKey, state.config.scope, state.notes);
  state.notice = `Recovered ${recovered.length} note${recovered.length === 1 ? "" : "s"} from ${deposits.length} pool deposits.`;
}

/**
 * Pull the whole L2 note feed and match locally.
 *
 * The view tag is a CLIENT-SIDE CPU optimisation — it skips the `v·E` scalar
 * mult for ~255/256 of notes. It is NOT a server-side query filter: asking the
 * relayer for "notes with view tag 0x07" would hand it a 1-in-256 fingerprint of
 * the recipient and tie an IP to a note set. So we fetch every candidate and
 * match entirely in the browser.
 */
async function scanForNotes() {
  if (!state.identity) throw new Error("Unlock your vault first.");

  // Scan EVERY destination. The recipient does not know (and should not need to
  // know) which chain a sender chose — that is the sender's decision, made after
  // the recipient published their address.
  const feeds = await Promise.all([
    ...evmChains().map((c) => fetchIndex(c.key, `/api/l2/${c.key}/index`)),
    fetchIndex("starknet", "/api/starknet/index"),
  ]);

  const { NoteService } = await sdk();
  const notes = new NoteService();
  const r = state.receive;
  r.scanned = [];
  r.scannedCount = 0;
  r.index = {};

  const problems = [];
  for (const feed of feeds) {
    if (feed.error) { problems.push(`${feed.chain}: ${feed.error}`); continue; }
    if (!feed.index?.configured) continue;

    r.index[feed.chain] = feed.index;
    const candidates = (feed.index.candidates ?? []).map((n) => ({
      commitment: BigInt(n.commitment),
      value: BigInt(n.value),
      ephemeralKey: n.ephemeralKey.map(BigInt),
      viewTag: n.viewTag,
    }));
    r.scannedCount += candidates.length;
    // Tag each hit with the chain it lives on and a cheap status derived from the
    // index we already have: activation, proving and withdrawal all diverge from
    // here (EVM Groth16 vs Cairo/Garaga).
    for (const note of notes.scanL2Notes(candidates, state.identity.shielded)) {
      r.scanned.push({ ...note, chain: feed.chain, _status: deriveL2Status(note, feed.index) });
    }
  }

  if (!Object.keys(r.index).length) {
    throw new Error(problems.length ? problems.join(" · ") : "No destination pool is configured on this relayer.");
  }
  if (r.selected && !selectedNote()) r.selected = null;
  state.notice = r.scanned.length
    ? `Found ${r.scanned.length} note${r.scanned.length === 1 ? "" : "s"} addressed to you.`
    : `Scanned ${r.scannedCount} note${r.scannedCount === 1 ? "" : "s"} across ${Object.keys(r.index).length} chain(s); none are yours.`;
}

async function fetchIndex(chain, path) {
  try {
    const response = await fetch(path);
    const index = await response.json();
    if (!response.ok) return { chain, error: index.error ?? "index unavailable" };
    return { chain, index };
  } catch (error) {
    return { chain, error: error instanceof Error ? error.message : "index unreachable" };
  }
}

async function refreshSelectedStatus() {
  const note = selectedNote();
  if (!note) return;
  const base = note.chain === "starknet" ? "/api/starknet/status" : `/api/l2/${note.chain}/status`;
  try {
    const response = await fetch(`${base}/${String(note.cDest)}`);
    state.receive.status = response.ok ? await response.json() : { state: "bridge-pending" };
  } catch {
    state.receive.status = { state: "bridge-pending" };
  }
}

/**
 * Fetch the server config, retrying with backoff.
 *
 * `render()` asks for the config whenever it is missing, and the failure path re-renders — so a
 * naive implementation re-enters itself and hammers /api/config as fast as the request can fail.
 * That is not hypothetical: `yarn dev` starts Vite instantly but the API server needs a few
 * seconds to load the SDK, and the gap produced ~80 ECONNREFUSED proxy errors per second.
 *
 * The in-flight and retry guards make the request idempotent across renders; the backoff turns a
 * cold API server into a handful of quiet retries that heal on their own once it binds.
 */
let configInFlight = false;
let configRetry = null;
let configAttempts = 0;

async function loadConfig() {
  if (state.config || configInFlight || configRetry) return;
  configInFlight = true;
  try {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error(`Configuration request failed (${response.status})`);
    state.config = await response.json();
    configAttempts = 0;
    loadStarknetStatus();
    render();
  } catch (error) {
    // The API server is probably still booting; say so rather than blaming the user's config.
    state.error = `${error instanceof Error ? error.message : "Configuration unavailable"}. Retrying…`;
    const delay = Math.min(500 * 2 ** configAttempts++, 5000);
    configRetry = setTimeout(() => { configRetry = null; loadConfig(); }, delay);
    render();
  } finally {
    configInFlight = false;
  }
}

/**
 * Is the Starknet destination safe to send to?
 *
 * The Cairo pool's `l1_pool` is immutable and `receive_note` asserts the message
 * came from it. If our L1 pool is not the bound one, the relay bridges the ETH
 * and then the note is REJECTED — the value arrives with no claimable note. So
 * Starknet is offered only when the server confirms the binding matches.
 */
async function loadStarknetStatus() {
  try {
    const response = await fetch("/api/starknet/config");
    state.starknet = response.ok ? await response.json() : { configured: false, unavailable: true };
  } catch {
    state.starknet = { configured: false, unavailable: true };
  }
  render();
}

/*//////////////////////////////////////////////////////////////
                              FLOWS
//////////////////////////////////////////////////////////////*/

function submitFlow() {
  return guard(async () => {
    if (state.view === "deposit") await runDeposit();
    else if (state.view === "send") await runSend();
    else if (state.view === "receive") await runReceive();
  });
}

/** Deposit with secrets DERIVED from the mnemonic at the next unused index. */
async function runDeposit() {
  const config = state.config;
  if (!config?.poolAddress) throw new Error("POOL_ADDRESS is not configured on the API.");
  if (!config.scope) throw new Error("POOL_SCOPE is not configured on the API.");

  const amount = sanitizeAmount(state.amount);
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(amount) || Number(amount) <= 0) throw new Error("Enter a positive ETH amount.");
  const value = parseEther(amount);
  if (value < BigInt(config.minDepositWei)) throw new Error(`Below the pool minimum of ${formatEther(BigInt(config.minDepositWei))} ${config.symbol}.`);
  if (value > BigInt(config.maxDepositWei)) throw new Error("Amount exceeds the protocol deposit limit.");

  const wallet = await walletClient();
  const client = readClient();
  if (await client.getBalance({ address: state.account }) < value) throw new Error(`Insufficient ${config.symbol} balance.`);

  // The index comes from CHAIN state, not a local counter: two devices sharing a
  // mnemonic would otherwise derive the same precommitment and the second
  // deposit would revert with PrecommitmentAlreadyUsed.
  const depositsResponse = await fetch("/api/l1/deposits");
  const depositsBody = await depositsResponse.json();
  if (!depositsResponse.ok) throw new Error(depositsBody.error ?? "Unable to index deposits.");
  const deposits = (depositsBody.deposits ?? []).map((d) => ({
    commitment: BigInt(d.commitment), label: BigInt(d.label),
    value: BigInt(d.value), precommitment: BigInt(d.precommitment),
  }));

  const { generateDepositSecrets, hashPrecommitment, nextDepositIndex } = await sdk();
  const scope = BigInt(config.scope);
  const index = nextDepositIndex(state.identity.mnemonic, scope, deposits);
  const { nullifier, secret } = generateDepositSecrets(state.identity.master, scope, index);
  const precommitment = hashPrecommitment(nullifier, secret);

  const hash = await wallet.writeContract({
    address: config.poolAddress, abi: poolAbi, functionName: "deposit",
    args: [precommitment], value,
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Deposit transaction reverted.");

  const event = await reconcileDeposit(hash);
  state.notes = [...state.notes, {
    index: index.toString(),
    commitment: event.commitment,
    label: event.label,
    value: event.value,
    nullifier: nullifier.toString(),
    secret: secret.toString(),
    status: "ready",
  }];
  await saveNotes(state.identity.vaultKey, state.config.scope, state.notes);
  state.notice = `Deposited ${formatEther(BigInt(event.value))} ${config.symbol} at index ${index}. Recoverable from your phrase.`;
  state.view = "home";
}

async function reconcileDeposit(hash) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const response = await fetch(`/api/deposits/${hash}`);
    if (response.ok) return (await response.json()).event;
    if (response.status !== 202) throw new Error("Deposit confirmed, but event reconciliation failed.");
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error("Deposit confirmed, but the pool event is still indexing.");
}

async function runSend() {
  const send = state.send;

  if (send.draft?.proof && !send.draft.relayed) {
    const draft = send.draft;
    const response = await fetch("/api/relayer/request", {
      method: "POST", headers: { "content-type": "application/json" },
      body: jsonBody({
        withdrawal: draft.withdrawal,
        publicSignals: draft.proof.publicSignals.map(String),
        proof: { pi_a: draft.proof.proof.pi_a, pi_b: draft.proof.proof.pi_b, pi_c: draft.proof.proof.pi_c },
        scope: draft.scope,
        chainId: state.config?.chainId,
        feeCommitment: draft.feeCommitment,
      }),
    });
    const result = await response.json();
    if (!response.ok || result.success === false) throw new Error(result.error ?? "L1 relay request failed.");
    draft.relayed = result;
    // The spent note is gone from the pool's perspective; mark it as history
    // rather than deleting it, so the portfolio can show what left.
    const spent = state.notes.find((n) => n.commitment === draft.selected.commitment);
    if (spent) { spent.status = "spent"; spent.spentTo = String(send.destinationChainId); }
    await saveNotes(state.identity.vaultKey, state.config.scope, state.notes);
    return;
  }

  if (!send.resolved) await resolveRecipient();
  const { B, V } = send.resolved;
  const selected = pickNote();
  if (!selected) throw new Error("No L1 note to spend.");
  if (!state.config?.scope) throw new Error("POOL_SCOPE is not configured on the API.");
  if (!state.account) await connectWallet();

  const { Circuits, NoteService, PrivacyPoolSDK, calculateRelayContext } = await sdk();
  const notes = new NoteService();

  // One ephemeral scalar for the note. The quote needs E/viewTag to build the
  // exact RelayData bytes the proof context binds; neither depends on value.
  const ephemeralScalar = randomField();
  const preview = notes.buildDestNote({ B, V }, BigInt(selected.value), ephemeralScalar);

  const quoteResponse = await fetch("/api/relayer/quote", {
    method: "POST", headers: { "content-type": "application/json" },
    body: jsonBody({
      chainId: state.config.chainId,
      amount: selected.value,
      asset: state.config.asset,
      // The SENDER's address. This lands in the public `WithdrawalRelayed` event,
      // so it must never be the recipient's exit address.
      recipient: state.account,
      ephemeralKey: preview.ephemeralKey.map(String),
      viewTag: preview.viewTag.toString(),
      extraGas: false,
    }),
  });
  const quote = await quoteResponse.json();
  if (!quoteResponse.ok) throw new Error(quote.error ?? "Relayer quote unavailable.");
  if (!quote.feeCommitment?.withdrawalData) throw new Error("Relayer did not return a signed fee commitment.");

  // Take the fee from the SIGNED bytes, not a sibling JSON field: those bytes are
  // what the proof context binds and what the relayer re-decodes to check
  // bridgedValue. A second source of truth silently produces a rejected relay.
  const feeBps = decodeRelayData(quote.feeCommitment.withdrawalData).relayFeeBPS;
  const bridgedValue = BigInt(selected.value) - ((BigInt(selected.value) * feeBps) / 10_000n);
  if (bridgedValue <= 0n) throw new Error("Relay fee leaves no value to bridge.");

  // C_dest folds the value in, so it must be rebuilt against the NET value.
  const destNote = notes.buildDestNote({ B, V }, bridgedValue, ephemeralScalar);
  const withdrawal = { chainId: BigInt(send.destinationChainId), data: quote.feeCommitment.withdrawalData };

  const [stateResponse, aspResponse] = await Promise.all([
    fetch(`/api/l1/state-proof/${selected.commitment}`),
    fetch(`/api/asp/proof/${selected.label}`),
  ]);
  const stateProof = await stateResponse.json();
  const aspProof = await aspResponse.json();
  if (!stateResponse.ok) throw new Error(stateProof.error ?? "L1 state proof unavailable.");
  if (!aspResponse.ok) throw new Error(aspProof.error ?? "ASP proof unavailable.");

  const pool = new PrivacyPoolSDK(new Circuits({ browser: true, baseUrl: `${window.location.origin}/api/circuits/` }));
  const context = BigInt(calculateRelayContext(withdrawal, BigInt(state.config.scope)));
  const proof = await pool.proveWithdrawalL1(
    { hash: BigInt(selected.commitment), value: BigInt(selected.value), label: BigInt(selected.label), nullifier: BigInt(selected.nullifier), secret: BigInt(selected.secret) },
    {
      context,
      withdrawnValue: BigInt(selected.value),
      bridgedValue,
      stateMerkleProof: stateProof.proof,
      stateRoot: BigInt(stateProof.root),
      stateTreeDepth: BigInt(stateProof.depth),
      aspMerkleProof: aspProof.proof,
      aspRoot: BigInt(aspProof.root),
      aspTreeDepth: BigInt(aspProof.depth),
      spendingPublicKey: B,
      sharedSecretX: destNote.sharedSecretX,
      newNullifier: randomField(),
      newSecret: randomField(),
    },
  );
  if (!(await pool.verifyWithdrawalL1(proof))) throw new Error("L1 proof verification failed.");

  send.draft = { selected, destNote, bridgedValue, withdrawal, feeCommitment: quote.feeCommitment, scope: state.config.scope, proof, relayed: null };
}

async function runReceive() {
  const r = state.receive;
  const note = selectedNote();
  if (!note) throw new Error("Select one of your scanned notes first.");
  const starknet = note.chain === "starknet";

  if (r.proof && !r.response) {
    // Starknet takes the raw snarkjs proof; the server converts it to Garaga felt
    // calldata. That conversion used to be a manual `garaga` CLI run pasted into
    // a textarea — the recipient never sees it now.
    const response = await fetch(starknet ? "/api/starknet/withdraw" : `/api/l2/${note.chain}/withdraw`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: jsonBody(
        starknet
          ? { withdrawal: r.withdrawal, proof: r.proof.proof, publicSignals: r.proof.publicSignals }
          : { withdrawal: r.withdrawal, proof: r.proof },
      ),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Withdrawal failed.");
    r.response = result;
    // Remember the landed note so the portfolio can show it as withdrawn history;
    // the on-chain status endpoint only ever reports it as `activated`.
    const id = String(note.cDest);
    state.withdrawn[id] = { value: note.value.toString(), chain: note.chain, recipient: (r.recipient ?? "").trim(), hash: result.hash ?? null, at: Date.now() };
    note._status = "withdrawn";
    await saveL2History(state.identity.vaultKey, state.config.scope, state.withdrawn);
    return;
  }

  await refreshSelectedStatus();
  const st = r.status?.state;

  if (st === "received-pending-activation") {
    const response = await fetch(starknet ? "/api/starknet/activate" : `/api/l2/${note.chain}/activate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: jsonBody({ commitment: note.cDest.toString() }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Note activation failed.");
    r.activation = result;
    await refreshSelectedStatus();
    return;
  }

  if (st === "activated") await prepareL2Proof(note);
}

/**
 * The scan already produced `stealthPrivKey` and `sharedSecretX` — derived from
 * the recipient's own keys. Nothing about them comes from the sender.
 */
async function prepareL2Proof(note) {
  const r = state.receive;
  const starknet = note.chain === "starknet";
  const recipient = (r.recipient ?? "").trim();

  const index = r.index?.[note.chain];
  if (!index) throw new Error("Scan again. The note's index is stale.");
  const entry = index.proofs?.find((item) => String(item.commitment) === String(note.cDest));
  if (!entry?.proof) throw new Error("The activated note is not indexed in the destination tree yet.");

  const configResponse = await fetch(starknet ? "/api/starknet/config" : `/api/l2/${note.chain}/config`);
  const config = await configResponse.json();
  if (!configResponse.ok || !config.configured) {
    throw new Error(config.error ?? `The ${starknet ? "Starknet" : "L2"} relayer is not configured.`);
  }

  const { encodeL2RelayData, calculateContext, calculateContextStarknet, Circuits, PrivacyPoolSDK } = await sdk();

  // The destination spend is its own relay with its own fee — NOT the L1 relay's
  // fee. The recipient sets it; the F5 relayer submits and eats the gas.
  let withdrawal;
  let context;
  if (starknet) {
    // A Starknet recipient is a felt252, not an EVM address. And the context is a
    // Poseidon FOLD, not keccak(abi.encode(...)): Garaga exposes only a 2-input
    // Poseidon, so the Cairo pool derives it that way and the SDK must mirror it.
    if (!/^(?:0x[0-9a-fA-F]+|\d+)$/.test(recipient) || BigInt(recipient) >= (1n << 251n)) {
      throw new Error("Enter a valid Starknet felt252 recipient for the final withdrawal.");
    }
    withdrawal = {
      processooor: BigInt(config.relayerAddress),
      recipient: BigInt(recipient),
      feeRecipient: BigInt(config.relayerAddress),
      relayFeeBPS: 0n,
    };
    context = calculateContextStarknet(withdrawal, BigInt(index.scope));
  } else {
    if (!isAddress(recipient)) throw new Error("Enter the final recipient address (0x…) for the L2 withdrawal.");
    withdrawal = {
      processooor: config.relayerAddress,
      data: encodeL2RelayData({ recipient, feeRecipient: config.relayerAddress, relayFeeBPS: 0n }),
    };
    context = BigInt(calculateContext(withdrawal, BigInt(index.scope)));
  }

  // Same circuit for both chains — only the verifier differs (Solidity vs Cairo).
  const pool = new PrivacyPoolSDK(new Circuits({ browser: true, baseUrl: `${window.location.origin}/api/circuits/` }));
  const proof = await pool.proveWithdrawalL2({
    context,
    noteValue: note.value,
    stateMerkleProof: { index: entry.proof.index, siblings: entry.proof.siblings.map(BigInt), root: BigInt(entry.proof.root) },
    stateRoot: BigInt(entry.proof.root),
    stateTreeDepth: BigInt(entry.depth),
    stealthPrivateKey: note.stealthPrivKey,
    sharedSecretX: note.sharedSecretX,
  });
  if (!(await pool.verifyWithdrawalL2(proof))) throw new Error("Destination proof verification failed.");

  // Starknet's `withdraw` entrypoint takes the felts as decimal strings.
  r.withdrawal = starknet
    ? {
        processooor: withdrawal.processooor.toString(),
        recipient: withdrawal.recipient.toString(),
        feeRecipient: withdrawal.feeRecipient.toString(),
        relayFeeBPS: withdrawal.relayFeeBPS.toString(),
      }
    : withdrawal;
  r.proof = proof;
}

render();
window.addEventListener("hashchange", render);
