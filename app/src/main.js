import "./style.css";
import { cachedPublicationStatus, renderVaultIdentityControls, storePublicationStatus } from "./vault-identity.js";
import { createPublicClient, createWalletClient, custom, decodeAbiParameters, formatEther, http, isAddress, parseEther, parseEventLogs } from "viem";
import {
  IDENTITY_UNWRAP_MESSAGE,
  createMnemonic,
  forgetIdentity,
  hasIdentity,
  hasLegacyNotes,
  identityUnwrapKind,
  importLegacyNotes,
  loadL2Scan,
  loadL2History,
  loadMnemonic,
  loadNotes,
  saveL2History,
  saveL2Scan,
  saveMnemonic,
  saveNotes,
  validateRecoveryPhrase,
} from "./vault.js";
import { preservedNotes, runSequentialScan } from "./scan-flow.js";
import { txLinkHtml } from "./explorer.js";
import { evmAddressProblem, recipientProblem } from "./recipient.js";
import { buildActivity, relativeTime } from "./activity.js";
import {
  RAGEQUIT_PATH,
  formatRagequitProof,
  hasRagequitConsent,
  partitionRagequitNotes,
  ragequitAccountKey,
  selectRagequitNote,
} from "./ragequit-flow.js";
// Single-input Poseidon over BN254 — byte-identical to the circuit's/SDK's Poseidon
// (verified), so an L1 note's `Poseidon([nullifier])` here matches the
// `existingNullifierHash` the pool burns on spend. `poseidon-lite` is browser-native
// (no Node deps), unlike maci-crypto's hashing module which pulls in ethers/assert.
import { poseidon1 } from "poseidon-lite/poseidon1";

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
 * Layout: when locked, a single centered onboarding card. When unlocked, the
 * active workspace occupies the main column while balance/actions and notes
 * form a compact rail. Public shielded keys and recovery controls sit below.
 */

const STARKNET_CHAIN_ID = "393402133025997798000961";
const UNLOCKED_SESSION_KEY = "f5-unlocked-session-v1";
const VAULT_PATHS = {
  home: "/vault",
  deposit: "/vault/deposit",
  send: "/vault/bridge",
  receive: "/vault/withdraw",
  activity: "/vault/activity",
  ragequit: RAGEQUIT_PATH,
};

const REGISTRY_ABI = [
  { type: "function", name: "registerKeys", stateMutability: "nonpayable", inputs: [{ name: "schemeId", type: "uint256" }, { name: "stealthMetaAddress", type: "bytes" }], outputs: [] },
  { type: "function", name: "stealthMetaAddressOf", stateMutability: "view", inputs: [{ name: "registrant", type: "address" }, { name: "schemeId", type: "uint256" }], outputs: [{ type: "bytes" }] },
];
const poolAbi = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [{ name: "precommitment", type: "uint256" }], outputs: [] },
  { type: "function", name: "depositors", stateMutability: "view", inputs: [{ name: "label", type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "nullifierHashes", stateMutability: "view", inputs: [{ name: "nullifierHash", type: "uint256" }], outputs: [{ type: "bool" }] },
  {
    type: "function", name: "ragequit", stateMutability: "nonpayable", outputs: [],
    inputs: [{
      name: "proof", type: "tuple", components: [
        { name: "pA", type: "uint256[2]" },
        { name: "pB", type: "uint256[2][2]" },
        { name: "pC", type: "uint256[2]" },
        { name: "pubSignals", type: "uint256[4]" },
      ],
    }],
  },
  {
    type: "event",
    name: "Deposited",
    inputs: [
      { name: "_depositor", type: "address", indexed: true },
      { name: "_commitment", type: "uint256", indexed: false },
      { name: "_label", type: "uint256", indexed: false },
      { name: "_value", type: "uint256", indexed: false },
      { name: "_precommitmentHash", type: "uint256", indexed: false },
    ],
  },
];

const state = {
  /** Which flow occupies the left workspace: "home" | "deposit" | "send" | "receive" | "ragequit". */
  view: "home",
  amount: "1",
  account: "",
  config: null,
  error: null,
  notice: null,
  /** Explorer anchor rendered under the current notice; cleared with it. */
  noticeTx: null,
  busy: false,
  /** Connected wallet's L1 balance in wei, as a string. Null until read. */
  walletBalance: null,
  noteProgress: null,
  scanProgress: { active: false, steps: [] },
  notesUi: { showSpent: false, expanded: {}, route: null },

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

  send: { noteCommitment: "", destinationChainId: "", destinationChosen: false, recipientMode: "self", recipientKey: "", resolved: null, draft: null },
  ragequit: { noteCommitment: "", confirmedCommitment: "", eligibility: {}, checkedFor: null, balance: null, proof: null, response: null },
  /** Starknet destination health. Bridging to a pool bound to a DIFFERENT L1 pool
   *  loses the funds: StarkGate delivers the ETH but `receive_note` reverts with
   *  NotL1Pool, so no note ever exists to claim it. Never offer it blind. */
  starknet: null,
  receive: { scanned: [], scannedCount: 0, index: {}, selected: null, recipient: "", status: null, proof: null, withdrawal: null, response: null },
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

/** Convert a bridge destination chain id into the route key used by the L2 note cache. */
function destinationKey(chainId) {
  const id = String(chainId);
  if (id === STARKNET_CHAIN_ID) return "starknet";
  return evmChains().find((chain) => String(chain.chainId) === id)?.key ?? id;
}

/**
 * Block-explorer origin for a route key ("l1", an EVM chain key, or "starknet"),
 * or "" when this deployment configured none.
 */
function explorerBase(chain) {
  if (!chain || chain === "l1") return state.config?.explorerUrl ?? "";
  if (chain === "starknet") return state.starknet?.explorerUrl ?? "";
  return evmChains().find((candidate) => candidate.key === chain)?.explorerUrl ?? "";
}

/** An explorer anchor for a transaction on `chain`, or "" when it cannot be linked. */
function txLink(hash, chain = "l1", label = "VIEW ON EXPLORER") {
  return txLinkHtml(explorerBase(chain), hash, label);
}

/*//////////////////////////////////////////////////////////////
                              RENDER
//////////////////////////////////////////////////////////////*/

function render() {
  const routedView = vaultViewFromPath(location.pathname);
  if (!routedView) return renderLanding();
  state.view = routedView;
  app.innerHTML = state.identity ? appShell() : onboardingShell();
  bind();
  if (!state.config) loadConfig();
}

function vaultViewFromPath(pathname) {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return Object.entries(VAULT_PATHS).find(([, path]) => path === normalized)?.[0] ?? null;
}

function navigateVault(view, { replace = false, capture = true, clearMessages = true } = {}) {
  const path = VAULT_PATHS[view] ?? VAULT_PATHS.home;
  if (capture) captureForm();
  state.view = view;
  if (clearMessages) {
    state.error = null;
    state.notice = null;
    state.noticeTx = null;
  }
  if (location.pathname !== path) history[replace ? "replaceState" : "pushState"]({}, "", path);
  render();
}

/** Chrome shared by both the onboarding and unlocked states. */
function topbar() {
  const acct = state.account ? `${state.account.slice(0, 6)}…${state.account.slice(-4)}` : "CONNECT";
  return `
    <header class="topbar">
      <a class="brand" href="/vault" data-view="home"><span class="brand-mark">${icons.mark}</span><span>F5</span><span class="tag pink">VAULT</span></a>
      <div class="wallet">
        <button class="network"><i class="dot route-ethereum"></i> ${state.config?.chainName ?? "Ethereum"}</button>
        <button id="connect" class="account">${acct}</button>
        ${state.identity ? `<button id="lock" class="account">LOCK</button>` : ""}
      </div>
    </header>`;
}

function footer() {
  return `<footer><span>© 2026 F5 / SHIELDED VAULT</span><span><a href="/">Home</a></span></footer>`;
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

/** Unlocked: workspace + compact rail. */
function appShell() {
  const workspace = state.view === "deposit" ? depositView()
    : state.view === "send" ? sendView()
    : state.view === "receive" ? receiveView()
    : state.view === "activity" ? activityView()
    : state.view === "ragequit" ? ragequitView()
    : homeView();
  return `
    <div class="vault-frame">
      ${topbar()}
      <main class="app-shell">
        <div class="vault-primary-grid">
          <section class="workspace-main">
            ${errorView()}
            ${workspace}
          </section>
          <aside class="vault-rail">
            ${vaultBalanceBar()}
            <section class="panel vault-notes-tile">${notesSection()}</section>
          </aside>
        </div>
      </main>
    </div>
    ${footer()}`;
}

function bind() {
  const on = (sel, event, fn) => app.querySelector(sel)?.addEventListener(event, fn);

  app.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", (event) => {
    event.preventDefault();
    const previousView = state.view;
    navigateVault(b.dataset.view);
    // Withdraw consumes the Vault's shared scan results. Entering the workspace
    // starts that one scanner; the left pane only reflects its loading state.
    if (b.dataset.view === "receive" && previousView !== "receive") {
      void guard(scanForNotes, "scan");
    }
    if (b.dataset.view === "ragequit" && previousView !== "ragequit") {
      void guard(refreshRagequitEligibility, "ragequit-check");
    }
  }));
  on("#connect", "click", () => guard(connectWallet));
  on("[data-connect-wallet]", "click", () => guard(connectWallet));
  on("#lock", "click", lockVault);
  on("#action", "click", submitFlow);
  on("#dismiss-error", "click", () => { state.error = null; render(); });
  on("[data-dismiss-notice]", "click", () => { state.notice = null; state.noticeTx = null; render(); });
  on("#amount", "input", (e) => { e.target.value = sanitizeAmount(e.target.value); state.amount = e.target.value; });
  on("#max-amount", "click", () => guard(async () => { state.amount = await maxDepositAmount(); }));
  app.querySelectorAll('input[name="send-chain"]').forEach((input) => input.addEventListener("change", (event) => {
    captureForm();
    state.send.destinationChainId = event.target.value;
    state.send.destinationChosen = Boolean(event.target.value);
    state.send.draft = null;
    render();
  }));
  app.querySelectorAll('input[name="send-note"]').forEach((input) => input.addEventListener("change", (event) => {
    state.send.noteCommitment = event.target.value;
    state.send.draft = null;
    render();
  }));
  app.querySelectorAll('input[name="send-recipient-mode"]').forEach((input) => input.addEventListener("change", (event) => {
    captureForm();
    state.send.recipientMode = event.target.value;
    state.send.resolved = null;
    state.send.draft = null;
    render();
  }));
  on("#send-recipient", "input", (event) => {
    state.send.recipientKey = event.target.value;
    state.send.resolved = null;
    state.send.draft = null;
    showFieldProblem("send-recipient-problem", evmAddressProblem(event.target.value));
  });
  on("#recv-recipient", "input", (event) => {
    state.receive.recipient = event.target.value;
    showFieldProblem("recv-recipient-problem", recipientProblem(event.target.value, selectedNote()?.chain));
  });

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
  on("#reveal-mnemonic", "click", () => { state.notice = `Recovery phrase. Write it down:\n\n${state.identity.mnemonic}`; state.noticeTx = null; render(); });
  on("#register-keys", "click", () => guard(registerShieldedAddress));
  app.querySelectorAll("[data-copy-shielded]").forEach((button) => button.addEventListener("click", () => {
    void guard(() => copyValue(button.dataset.copyLabel, button.dataset.copyShielded));
  }));
  // Generic copy. Note rows nest this inside a clickable row, so the click must not
  // also fire the row's "open this note" navigation.
  app.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    event.preventDefault();
    void guard(() => copyValue(button.dataset.copyLabel, button.dataset.copy));
  }));
  app.querySelectorAll("[data-scan]").forEach((b) => b.addEventListener("click", () => guard(scanForNotes, "scan")));
  // Refresh one route without paying for every other destination's index fetch.
  // L1 recovery always rides along: it is what reconciles the spent set, and a
  // route read against a stale spent set offers notes the pool would reject.
  app.querySelectorAll("[data-rescan-route]").forEach((b) => b.addEventListener("click", () => {
    const route = b.dataset.rescanRoute;
    const only = route === "l1" ? ["l1"] : ["l1", route];
    void guard(() => scanForNotes({ only }), "scan");
  }));
  on("#toggle-spent-notes", "change", (event) => {
    captureForm();
    state.notesUi.showSpent = event.target.checked;
    render();
  });
  app.querySelectorAll("[data-notes-route]").forEach((button) => button.addEventListener("click", () => {
    state.notesUi.route = button.dataset.notesRoute;
    render();
  }));
  on("[data-notes-back]", "click", () => {
    state.notesUi.route = null;
    render();
  });
  app.querySelectorAll("[data-expand-notes]").forEach((button) => button.addEventListener("click", () => {
    captureForm();
    const group = button.dataset.expandNotes;
    state.notesUi.expanded[group] = !state.notesUi.expanded[group];
    render();
  }));
  on("#resolve-recipient", "click", () => guard(resolveRecipient));
  app.querySelectorAll('input[name="ragequit-note"]').forEach((input) => input.addEventListener("change", (event) => {
    selectRagequitNote(state.ragequit, event.target.value);
    render();
  }));
  on("#ragequit-confirm", "change", (event) => {
    state.ragequit.confirmedCommitment = event.target.checked ? state.ragequit.noteCommitment : "";
    state.ragequit.proof = null;
    render();
  });
  on("#refresh-ragequit", "click", () => guard(refreshRagequitEligibility, "ragequit-check"));

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
  app.querySelectorAll("[data-send-note]").forEach((el) => activate(el, () => {
    captureForm();
    state.send.noteCommitment = el.dataset.sendNote;
    state.send.draft = null;
    navigateVault("send");
  }));

  // Pick a spendable L2 note from the Withdraw workspace and refresh its status.
  app.querySelectorAll("[data-pick-l2]").forEach((el) => activate(el, () => selectL2Note(el.dataset.pickL2)));
  // The rows above are labels wrapping a radio, so arrow keys move the selection
  // without ever producing a click. Without this, a keyboard user can check a note
  // and watch the workspace keep the previous one.
  app.querySelectorAll('input[name="withdraw-note"]').forEach((input) =>
    input.addEventListener("change", (event) => selectL2Note(event.target.value)));
}

/**
 * Clicking a row fires this, and so can the wrapped radio's `change`. That is
 * harmless — `guard` drops the second call while the first is in flight — and it
 * is deliberately not deduped by id, because re-picking the selected note is how
 * the user asks for a fresh status read.
 */
function selectL2Note(id) {
  captureForm();
  const r = state.receive;
  r.selected = id;
  r.status = null; r.proof = null; r.response = null;
  navigateVault("receive");
  void guard(refreshSelectedStatus);
}

/**
 * Bind an action to both click and Enter/Space.
 *
 * Rows that carry `role="button"` are announced as buttons and must answer the
 * keyboard like one; a click-only handler makes them a dead end for anyone not
 * using a mouse.
 */
function activate(el, run) {
  el.addEventListener("click", run);
  el.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    run();
  });
}

/** Run an async handler with uniform busy/error handling. */
async function guard(fn, noteProgress = null) {
  if (state.busy) return;
  state.busy = true;
  state.noteProgress = noteProgress;
  state.error = null;
  // Any explorer link belongs to the action that just finished, never the next one.
  state.noticeTx = null;
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
    state.noteProgress = null;
    render();
    // The error banner lives at the top of the workspace but actions sit at the bottom, so a
    // failure can land off-screen. Bring it into view rather than looking like a no-op.
    if (state.error) app.querySelector(".error-card")?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function lockVault() {
  // Wipe only the in-memory identity + derived caches. The encrypted vault stays
  // on disk — this is a lock, not a forget.
  clearUnlockedSession();
  clearFormDraft();
  state.identity = null;
  state.notes = [];
  state.withdrawn = {};
  state.registered = null;
  state.noticeTx = null;
  state.walletBalance = null;
  state.view = "home";
  state.scanProgress = { active: false, steps: [] };
  state.receive = { scanned: [], scannedCount: 0, index: {}, selected: null, recipient: "", status: null, proof: null, withdrawal: null, response: null };
  state.send = { noteCommitment: "", destinationChainId: "", destinationChosen: false, recipientMode: "self", recipientKey: "", resolved: null, draft: null };
  state.ragequit = { noteCommitment: "", confirmedCommitment: "", eligibility: {}, checkedFor: null, balance: null, proof: null, response: null };
  navigateVault("home", { replace: true, capture: false });
}

function renderLanding() {
  app.innerHTML = `
    <header class="topbar landing-topbar">
      <a class="brand" href="/"><span class="brand-mark">${icons.mark}</span><span>F5</span><span class="tag pink">A NODE TO TORNADO CASH</span></a>
      <nav><a class="active teal-underline" href="/">Protocol</a><a class="pink-underline" href="#docs">Docs</a><a class="launch" href="/vault">OPEN VAULT ↗</a></nav>
    </header>
    <main class="landing">
      <section class="hero"><div class="hero-copy"><span class="sticker teal hero-sticker">★ THE HIGHEST CATEGORY ★</span><h1>BLOW AWAY<br>YOUR <span>TRAIL</span></h1><p>F5 is an independent relayer node. We broadcast your withdrawal and pay the gas, so your fresh wallet stays fresh and nothing on-chain points back at you.</p><div class="hero-actions"><a class="primary hero-primary" href="/vault">OPEN THE VAULT →</a><a class="secondary" href="#how">HOW IT WORKS</a></div><div class="node-pill"><i class="dot teal-dot"></i> NODE ONLINE</div></div><div class="hero-art"><div class="art-dots"></div><div class="trail-bars"><i class="bar blue-bar"></i><i class="bar teal-bar"></i><i class="bar yellow-bar"></i><i class="bar pink-bar"></i><i class="bar orange-bar"></i><i class="bar blue-bar short"></i><i class="bar teal-bar tiny"></i><b></b></div><span class="figure-label">FIG. 01 / CATEGORY F5</span></div></section>
      <section id="how" class="how landing-how"><span class="eyebrow teal-text">THE SIMPLE VERSION</span><h2>THREE SPINS & YOU’RE GONE <span class="blue-text">〰</span></h2><div class="steps">${step("1", "ONE PHRASE", "Twelve words derive your note secrets, your shielded address, and your vault. It is the only thing you ever back up.", "MNEMONIC ROOT", "yellow")}${step("2", "BRIDGE BLIND", "You pay a shielded address using only its public keys. You never learn where the recipient cashes out.", "PUBLIC KEYS ONLY", "pink")}${step("3", "SCAN & LAND", "The recipient finds the note by scanning. Nobody tells them it exists, and they can withdraw anywhere.", "UNLINKABLE", "teal")}</div></section>
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
                         VAULT TILES
//////////////////////////////////////////////////////////////*/

/** The rail's first tile: the number that matters and the three core flows. */
function vaultBalanceBar() {
  return `
    <section class="panel vault-summary">
      ${balanceCard()}
      <div class="vault-actions">
        <button class="primary" data-view="deposit">DEPOSIT →</button>
        <button class="secondary-btn" data-view="send">BRIDGE</button>
        <button class="secondary-btn" data-view="receive">WITHDRAW</button>
        <button class="secondary-btn" data-view="activity">ACTIVITY</button>
        <button class="secondary-btn emergency-action" data-view="ragequit">EMERGENCY EXIT</button>
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

/** A fixed-size route browser. Route details scroll inside the tile. */
function notesSection() {
  const showSpent = state.notesUi.showSpent;
  const scanning = state.noteProgress === "scan";
  const routes = notesRoutes();
  const selected = routes.find((route) => route.key === state.notesUi.route);

  if (selected) return notesRouteDetail(selected, showSpent);

  return `
    <section class="notes-section notes-index">
      <div class="notes-heading">
        <div><h2>NOTES</h2><p>Tap a route to open the notes owned by this vault.</p></div>
        <div class="notes-heading-actions"><label class="spent-toggle"><input id="toggle-spent-notes" type="checkbox" ${showSpent ? "checked" : ""}><span>SHOW SPENT</span></label><button data-scan class="unlock" ${state.busy ? "disabled" : ""}>${progressLabel(scanning, "SCAN", "SCANNING")}</button></div>
      </div>
      <div class="route-summary-grid">${routes.map(routeSummary).join("")}</div>
    </section>`;
}

function notesRoutes() {
  const ready = state.notes.filter((note) => note.status !== "spent").length;
  const spent = state.notes.filter((note) => note.status === "spent").length;
  const routes = [{ key: "l1", layer: "L1", label: "Ethereum", icon: "≡", color: "ethereum", detail: `${ready} ready · ${spent} spent` }];
  evmChains().forEach((chain) => routes.push(l2NotesRoute(chain.key, chain.chainName, chainBrand(chain.key, chain.chainName))));
  if (state.starknet?.configured || l2List("starknet").length) {
    routes.push(l2NotesRoute("starknet", "Starknet", "starknet"));
  }
  return routes;
}

function chainBrand(key, label) {
  const route = `${key} ${label}`.toLowerCase();
  if (route.includes("optimism") || /(^|\s)op(\s|$)/.test(route)) return "optimism";
  if (route.includes("base")) return "base";
  if (route.includes("arbitrum") || route.includes("arb")) return "arbitrum";
  if (route.includes("starknet")) return "starknet";
  return "ethereum";
}

function l2NotesRoute(chain, label, color) {
  const notes = l2List(chain);
  const spendable = notes.filter((note) => note.status === "spendable").length;
  const waiting = notes.filter((note) => note.status === "activate" || note.status === "pending").length;
  return { key: chain, layer: "L2", label, icon: chain === "starknet" ? "SN" : chainInitials(label), color, detail: `${spendable} available · ${waiting} pending` };
}

function routeSummary(route) {
  const step = state.scanProgress.active
    ? state.scanProgress.steps.find((candidate) => candidate.key === route.key)
    : null;
  const scanLabels = { pending: "WAITING", scanning: "SCANNING", complete: "DONE", skipped: "SKIPPED", error: "ERROR" };
  const scanState = step?.status ?? "";
  const detail = step
    ? `${scanLabels[scanState] ?? "WAITING"} · ${step.detail ?? "Waiting for the previous route"}`
    : route.detail;
  return `
    <button class="route-summary ${scanState ? `is-${scanState}` : ""}" type="button" data-notes-route="${escapeHtml(route.key)}" aria-label="Open ${escapeHtml(route.label)} notes">
      <span class="route-summary-logo route-${escapeHtml(route.color)}" aria-hidden="true">${escapeHtml(route.icon)}</span>
      <span class="route-summary-copy"><b>${escapeHtml(route.layer)} · ${escapeHtml(route.label)}</b><small title="${escapeHtml(detail)}">${scanState === "scanning" ? '<span class="spinner" aria-hidden="true"></span>' : ""}${escapeHtml(detail)}</small></span>
      <span class="route-summary-arrow" aria-hidden="true">›</span>
    </button>`;
}

function notesRouteDetail(route, showSpent) {
  const list = route.key === "l1"
    ? state.notes.filter((note) => showSpent || note.status !== "spent")
    : l2List(route.key).filter((note) => showSpent || note.status !== "withdrawn");
  const rows = route.key === "l1"
    ? list.map(l1NoteRow).join("")
    : list.map((note) => l2NoteRow(note, route.key)).join("");
  return `
    <section class="notes-section notes-detail">
      <div class="notes-detail-head">
        <button class="notes-back" type="button" data-notes-back>‹ ALL ROUTES</button>
        <div class="notes-detail-title">
          <span class="eyebrow">${escapeHtml(route.layer)} · ROUTE</span>
          <div><h2>${escapeHtml(route.label)}</h2><strong>${list.length} note${list.length === 1 ? "" : "s"}</strong></div>
        </div>
        <button class="unlock notes-route-rescan" type="button" data-rescan-route="${escapeHtml(route.key)}" ${state.busy ? "disabled" : ""}>${progressLabel(state.noteProgress === "scan", "RESCAN", "SCANNING")}</button>
      </div>
      <div class="notes-detail-list">
        ${rows || `<div class="note-empty">No notes on this route.<br><span>Run RESCAN to refresh this route.</span></div>`}
      </div>
    </section>`;
}

function progressLabel(active, idleLabel, activeLabel) {
  return active ? `<span class="spinner" aria-hidden="true"></span>${activeLabel}` : idleLabel;
}

function notePreview(group, list, renderRow, emptyTitle, emptyHint) {
  if (!list.length) return `<div class="note-empty">${emptyTitle}<br><span>${emptyHint}</span></div>`;
  const expanded = Boolean(state.notesUi.expanded[group]);
  const visible = expanded ? list : list.slice(0, 2);
  return `${visible.map(renderRow).join("")}${list.length > 2
    ? `<button class="note-more" data-expand-notes="${escapeHtml(group)}">${expanded ? "SHOW LESS" : `MORE +${list.length - 2}`}</button>`
    : ""}`;
}

function l1NoteRow(n) {
  const spent = n.status === "spent";
  const attr = spent ? "" : `data-send-note="${n.commitment}" role="button" tabindex="0"`;
  return `
    <div class="vnote ${spent ? "is-past" : ""}" ${attr}>
      <span class="note-icon route-ethereum">${icons.eth}</span>
      <div><strong>${formatEther(BigInt(n.value))} ETH</strong><small>${n.legacy ? "legacy" : `#${n.index}`}　·　${short(n.commitment)}</small>${copyButton(n.commitment, "Commitment")}</div>
      ${pill(spent ? "spent" : "ready")}
    </div>`;
}

function l2Group(chain) {
  const list = l2List(chain).filter((x) => state.notesUi.showSpent || x.status !== "withdrawn");
  if (!list.length) return "";
  return notePreview(`l2-${chain}`, list, (x) => {
    const availability = availabilityEstimate(x, chain);
    return `
      <div class="vnote ${x.status === "withdrawn" ? "is-past" : ""}">
        <span class="note-icon route-${chainBrand(chain, chainLabel(chain))}">${icons.eth}</span>
        <div><strong>${formatEther(BigInt(x.value))} ETH</strong><small>${short(x.id)}</small>${availability ? `<small class="note-eta">${escapeHtml(availability)}</small>` : ""}${copyButton(x.id, "Note commitment")}</div>
        ${pill(x.status)}
      </div>`;
  }, "", "");
}

function l2NoteRow(x, chain) {
  const availability = availabilityEstimate(x, chain);
  return `
    <div class="vnote ${x.status === "withdrawn" ? "is-past" : ""}">
      <span class="note-icon route-${chainBrand(chain, chainLabel(chain))}">${icons.eth}</span>
      <div><strong>${formatEther(BigInt(x.value))} ETH</strong><small>${short(x.id)}</small>${availability ? `<small class="note-eta">${escapeHtml(availability)}</small>` : ""}${copyButton(x.id, "Note commitment")}</div>
      ${pill(x.status)}
    </div>`;
}

function l2VaultGroup(chain, label) {
  const notes = l2Group(chain);
  if (!notes) return "";
  return `<div class="group-heading"><h3>L2 · ${escapeHtml(String(label).toUpperCase())}</h3></div>${notes}`;
}

const PILL = {
  ready: ["READY", "ok"],
  spendable: ["SPENDABLE", "ok"],
  activate: ["ACTIVATING", "warn"],
  pending: ["AWAITING L2", "warn"],
  withdrawn: ["WITHDRAWN ✓", "past"],
  spent: ["SPENT →", "past"],
};
function pill(status) {
  const [label, cls] = PILL[status] ?? ["?", "warn"];
  return `<span class="pill ${cls}">${label}</span>`;
}

/** Human ETA for an L2 note that is not spendable yet. */
function availabilityEstimate(note, chain) {
  if (note.status === "activate") return "LESS THAN 1 MIN LEFT";
  if (note.status !== "pending") return "";

  // Canonical L1→L2 delivery windows. Arbitrum contracts enter the delayed
  // inbox; OP Stack routes settle faster, while StarkGate is usually ~5 min.
  const chainId = String(evmChains().find((candidate) => candidate.key === chain)?.chainId ?? "");
  const [minMinutes, maxMinutes] = ["42161", "42170", "421614"].includes(chainId) || chain === "arb"
    ? [10, 15]
    : chain === "starknet"
      ? [3, 5]
      : [2, 5];
  const bridgedAt = Number(note.bridgedAt);
  if (!Number.isFinite(bridgedAt) || bridgedAt <= 0) {
    return `${minMinutes}–${maxMinutes} MIN LEFT`;
  }

  const minAt = bridgedAt + minMinutes * 60_000;
  const maxAt = bridgedAt + maxMinutes * 60_000;
  const minLeft = Math.max(0, Math.ceil((minAt - Date.now()) / 60_000));
  const maxLeft = Math.max(0, Math.ceil((maxAt - Date.now()) / 60_000));
  if (maxLeft === 0) return "EXPECTED ANY MOMENT · RUN SCAN TO REFRESH";
  if (minLeft === 0) return `${maxLeft} MIN LEFT`;
  return `${minLeft}–${maxLeft} MIN LEFT`;
}

/*//////////////////////////////////////////////////////////////
                        WORKSPACE VIEWS
//////////////////////////////////////////////////////////////*/

function flowHead(eyebrow, title, sub) {
  return `<div class="flow-head"><div><span class="eyebrow">${eyebrow}</span><h2>${title}</h2><p>${sub}</p></div><button class="ghost" data-view="home">← DASHBOARD</button></div>`;
}

function actionRoute(path, color, delay = 0) {
  return `<path class="action-route route-${color}" d="${path}" /><path class="action-route-motion" style="animation-delay:${delay}s" d="${path}" />`;
}

function actionFlowNode(node, x, y, side) {
  const textX = side === "left" ? x - 38 : x + 38;
  const anchor = side === "left" ? "end" : "start";
  return `<g class="action-flow-node">
    <circle class="action-node-badge route-${node.color}" cx="${x}" cy="${y}" r="24" />
    <text class="action-node-icon route-label-${node.color}" x="${x}" y="${y + 1}">${escapeHtml(node.icon)}</text>
    <text class="action-node-title" x="${textX}" y="${y - 3}" text-anchor="${anchor}">${escapeHtml(node.title)}</text>
    <text class="action-node-detail" x="${textX}" y="${y + 19}" text-anchor="${anchor}">${escapeHtml(node.detail)}</text>
  </g>`;
}

function actionFlowDiagram({ ariaLabel, source, targets, interchange = false, inactive = false }) {
  const count = Math.max(targets.length, 1);
  const height = Math.max(460, 120 + count * 118);
  const centerY = height / 2;
  const topY = count === 1 ? centerY : 72;
  const step = count === 1 ? 0 : (height - 144) / (count - 1);
  const targetLayout = targets.map((target, index) => ({ target, y: topY + index * step }));
  const commonRoute = interchange ? actionRoute(`M 270 ${centerY} L 530 ${centerY}`, source.color) : "";
  const routes = targetLayout.map(({ target, y }, index) => {
    const path = interchange
      ? `M 530 ${centerY} C 615 ${centerY}, 650 ${y}, 750 ${y}`
      : `M 270 ${centerY} C 420 ${centerY}, 620 ${y}, 750 ${y}`;
    return actionRoute(path, target.color, index * -0.2);
  }).join("");
  const nodes = targetLayout.map(({ target, y }) => actionFlowNode(target, 774, y, "right")).join("");

  return `<div class="action-flow-diagram ${inactive ? "flow-inactive" : ""}">
    <svg viewBox="0 0 1060 ${height}" role="img" aria-label="${escapeHtml(ariaLabel)}">
      ${commonRoute}${routes}
      ${actionFlowNode(source, 246, centerY, "left")}
      ${nodes || `<text class="action-flow-empty" x="774" y="${centerY}">NO DESTINATIONS</text>`}
      ${interchange ? `<image class="action-interchange" href="/f5-eye.svg" x="498" y="${centerY - 32}" width="64" height="64" /><text class="action-interchange-label" x="530" y="${centerY + 91}">F5</text>` : ""}
    </svg>
  </div>`;
}

function depositFlowDiagram() {
  return actionFlowDiagram({
    ariaLabel: "Funds move from your wallet into the Ethereum privacy pool",
    source: { icon: "YOU", title: "YOUR WALLET", detail: "PUBLIC FUNDS", color: "pink" },
    targets: [{ icon: "Ξ", title: "ETHEREUM POOL", detail: "SHIELDED NOTE", color: "ethereum" }],
  });
}

function bridgeTargets() {
  const targets = evmChains().map((chain) => ({ id: String(chain.chainId), key: chain.key, label: chain.chainName }));
  if (state.starknet?.configured) targets.push({ id: STARKNET_CHAIN_ID, key: "starknet", label: "Starknet Sepolia" });
  return targets;
}

function bridgeFlowDiagram(send) {
  const targets = bridgeTargets().map((target) => ({ ...target, color: chainBrand(target.key, target.label) }));
  const selected = send.destinationChosen ? targets.find((target) => target.id === send.destinationChainId) : null;
  if (selected) {
    return actionFlowDiagram({
      ariaLabel: `Note bridges from Ethereum to ${selected.label}`,
      source: { icon: "Ξ", title: "ETHEREUM POOL", detail: "L1 NOTE", color: "ethereum" },
      targets: [{ icon: chainInitials(selected.label), title: selected.label, detail: "SHIELDED NOTE", color: selected.color }],
      interchange: true,
    });
  }
  return actionFlowDiagram({
    ariaLabel: "Ethereum note can bridge to any configured destination",
    source: { icon: "Ξ", title: "ETHEREUM POOL", detail: "CHOOSE A BRIDGE", color: "ethereum" },
    targets: targets.length
      ? targets.map((target) => ({ icon: chainInitials(target.label), title: target.label, detail: "DESTINATION", color: target.color }))
      : [{ icon: "?", title: "NO BRIDGES", detail: "NOT CONFIGURED", color: "muted" }],
    interchange: true,
  });
}

function withdrawFlowDiagram(note) {
  const label = note ? chainLabel(note.chain) : "SELECT A NOTE";
  const detail = note ? `${formatEther(note.value)} ETH` : "FROM THE VAULT";
  return actionFlowDiagram({
    ariaLabel: "Selected note withdraws to your account",
    source: { icon: note ? chainInitials(label) : "?", title: label, detail, color: note ? chainBrand(note.chain, label) : "muted" },
    targets: [{ icon: "YOU", title: "YOUR ACCOUNT", detail: "FINAL RECIPIENT", color: "pink" }],
    inactive: !note,
  });
}

function chainInitials(label) {
  return String(label).split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
}

/** Default left pane: a chain map showing where the user's current notes live. */
function homeView() {
  const l1Notes = state.notes.filter((note) => note.status !== "spent");
  const l1Total = l1Notes.reduce((sum, note) => sum + BigInt(note.value), 0n);
  const destinations = evmChains().map((chain) => noteMapDestination(chain.key, chain.chainName));
  if (state.starknet?.configured || l2List("starknet").length) {
    destinations.push(noteMapDestination("starknet", "Starknet"));
  }
  return `
    <section class="panel home-panel">
      <div class="map-heading">
        <div><span class="eyebrow">WHERE YOUR NOTES LIVE</span><h2>TRANSIT MAP</h2><p>Chains are stations. F5 is the interchange.</p></div>
      </div>
      ${metroMap(destinations, l1Total, l1Notes.length)}
      <p class="micro">current shielded notes only ★ spent and withdrawn history is not counted</p>
      ${renderVaultIdentityControls({
        shielded: state.identity.shielded,
        account: state.account,
        registered: state.registered,
        busy: state.busy,
      })}
      ${noticeView()}
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
  return { key, label, initials, total, available, pending, noteCount: notes.length, stateClass, color: chainBrand(key, label) };
}

function metroMap(destinations, l1Total, l1NoteCount) {
  const count = Math.max(destinations.length, 1);
  const height = Math.max(460, 120 + count * 118);
  const centerY = height / 2;
  const topY = count === 1 ? centerY : 72;
  const step = count === 1 ? 0 : (height - 144) / (count - 1);
  const destinationLayout = destinations.map((destination, index) => {
    const y = topY + index * step;
    const color = destination.color;
    const path = `M 462 ${centerY} C 535 ${centerY}, 580 ${y}, 733 ${y}`;
    return { destination, y, color, path };
  });
  const routes = destinationLayout.map(({ color, path }) =>
    `<path class="metro-route route-${color}" d="${path}" />`).join("");
  const destinationCards = destinationLayout.map(({ destination, y, color }) => `
    <g class="metro-destination ${destination.stateClass}">
      <circle class="metro-badge route-${color}" cx="733" cy="${y}" r="23" />
      <text class="metro-badge-text route-label-${color}" x="733" y="${y + 1}">${escapeHtml(destination.initials)}</text>
      <text class="metro-chain-total" x="770" y="${y - 25}"><tspan>${fmt(destination.total)}</tspan><tspan class="metro-currency" dx="7">ETH</tspan></text>
      <text class="metro-chain-name" x="770" y="${y + 3}">${escapeHtml(destination.label)}</text>
      <text class="metro-chain-detail" x="770" y="${y + 28}">${fmt(destination.available)} AVAIL · ${fmt(destination.pending)} PENDING · ${destination.noteCount} NOTE${destination.noteCount === 1 ? "" : "S"}</text>
    </g>`).join("");

  return `<div class="note-map metro-map">
    <svg viewBox="0 0 1060 ${height}" role="img" aria-label="Shielded note transit map from Ethereum through F5 to configured L2 chains">
      <line class="metro-route route-ethereum" x1="147" y1="${centerY}" x2="402" y2="${centerY}" />
      ${routes}
      <g class="metro-source-card">
        <text class="metro-chain-total" x="105" y="${centerY - 25}" text-anchor="end"><tspan>${fmt(l1Total)}</tspan><tspan class="metro-currency" dx="7">ETH</tspan></text>
        <text class="metro-chain-name" x="105" y="${centerY + 4}" text-anchor="end">ETHEREUM</text>
        <text class="metro-chain-detail" x="105" y="${centerY + 30}" text-anchor="end">${l1NoteCount} READY NOTE${l1NoteCount === 1 ? "" : "S"}</text>
        <circle class="metro-badge route-ethereum" cx="147" cy="${centerY}" r="24" />
        <text class="metro-badge-text" x="147" y="${centerY + 1}">Ξ</text>
      </g>
      ${destinationCards}
      <image class="metro-interchange" href="/f5-eye.svg" x="399" y="${centerY - 32}" width="64" height="64" />
      <text class="metro-interchange-label" x="431" y="${centerY + 91}">F5</text>
      ${destinations.length ? "" : `<text class="metro-empty" x="686" y="${centerY}">NO L2 DESTINATIONS CONFIGURED</text>`}
    </svg>
  </div>`;
}

function depositView() {
  const config = state.config;
  const minimum = config?.minDepositWei && config.minDepositWei !== "0" ? `${formatEther(BigInt(config.minDepositWei))} ${config.symbol}` : "not available";
  return `
    <section class="panel flow-panel">
      ${flowHead("L1 · ETHEREUM", "DEPOSIT", "Put value into the pool. The note's secrets come from your phrase, so it survives a wiped browser.")}
      ${depositFlowDiagram()}
      ${noticeView()}
      <div class="field-label"><span>FROM</span><span>${state.walletBalance === null ? "" : `BALANCE ${fmt(BigInt(state.walletBalance))} ${config?.symbol ?? "ETH"}　·　`}<i class="dot route-ethereum"></i> ${config?.chainName ?? "LOADING"}</span></div>
      <div class="amount-field"><div><input id="amount" value="${sanitizeAmount(state.amount)}" inputmode="decimal" autocomplete="off" /><small>Any amount · minimum ${minimum}</small></div>${state.walletBalance === null ? "" : `<button id="max-amount" type="button" class="max-chip" ${state.busy ? "disabled" : ""}>MAX</button>`}<button class="asset">${icons.eth} ${config?.symbol ?? "ETH"}</button></div>
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
  const recipientMode = send.recipientMode === "other" ? "other" : "self";
  const targetOption = (value, key, label, disabled = false) => `<label class="bridge-option target-option ${disabled ? "is-disabled" : ""}">
    <input type="radio" name="send-chain" value="${value}" ${send.destinationChainId === value ? "checked" : ""} ${disabled ? "disabled" : ""} />
    <span class="bridge-option-icon route-${chainBrand(key, label)}">${escapeHtml(key === "starknet" ? "SN" : chainInitials(label))}</span>
    <span><b>${escapeHtml(label)}</b><small>${disabled ? "UNAVAILABLE" : "BRIDGE DESTINATION"}</small></span>
  </label>`;
  const noteOption = (note) => `<label class="bridge-option note-option">
    <input type="radio" name="send-note" value="${note.commitment}" ${selected?.commitment === note.commitment ? "checked" : ""} />
    <span class="bridge-option-icon route-ethereum">Ξ</span>
    <span><b>${formatEther(BigInt(note.value))} ETH</b><small>#${note.index} · ${short(note.commitment)}</small></span>
    <span class="pill ok">READY</span>
  </label>`;
  const starknetUsable = state.starknet?.configured === true;
  const recipientReady = recipientMode === "self" || Boolean(send.recipientKey.trim());
  // Proving is a long, main-thread-blocking wasm run — say so, or the button looks dead.
  const action = state.busy
    ? (draft?.proof ? "SUBMITTING RELAY…" : "PROVING… THIS CAN TAKE A MINUTE")
    : draft?.relayed ? "RELAY SUBMITTED ✓" : draft?.proof ? "SUBMIT L1 RELAY →" : "QUOTE & PROVE →";

  return `
    <section class="panel flow-panel">
      ${flowHead("L1 · ETHEREUM", "BRIDGE A NOTE", ready.length ? "Spend an L1 note, bridge its value, and deliver it to a shielded address." : "No spendable L1 notes. Deposit, or run SCAN.")}
      ${bridgeFlowDiagram(send)}
      ${noticeView()}
      <fieldset class="bridge-choice note-choice"><legend>L1 NOTE TO SPEND</legend>
        ${ready.length ? ready.map(noteOption).join("") : `<div class="note-empty">No spendable L1 notes.</div>`}
      </fieldset>
      <fieldset class="bridge-choice target-choice"><legend>BRIDGE TARGET</legend>
        ${evmChains().map((chain) => targetOption(String(chain.chainId), chain.key, chain.chainName)).join("")}
        ${state.starknet ? targetOption(STARKNET_CHAIN_ID, "starknet", "Starknet Sepolia", !starknetUsable) : ""}
      </fieldset>
      ${starknetWarning()}
      <fieldset class="bridge-choice recipient-choice"><legend>WHO IS RECEIVING THE NOTE?</legend>
        <label class="bridge-option"><input type="radio" name="send-recipient-mode" value="self" ${recipientMode === "self" ? "checked" : ""} /><span><b>SELF BRIDGE</b><small>SEND TO MY SHIELDED VAULT</small></span></label>
        <label class="bridge-option"><input type="radio" name="send-recipient-mode" value="other" ${recipientMode === "other" ? "checked" : ""} /><span><b>DIFFERENT USER</b><small>LOOK UP THEIR REGISTERED KEYS</small></span></label>
      </fieldset>
      ${recipientMode === "other" ? `
        <label class="input-label">RECIPIENT L1 ADDRESS
          <input id="send-recipient" placeholder="0x… registered Ethereum address" value="${escapeHtml(send.recipientKey)}" autocomplete="off" spellcheck="false" />
          ${fieldProblemSlot("send-recipient-problem", evmAddressProblem(send.recipientKey))}
        </label>
        <div class="key-actions"><button id="resolve-recipient" class="secondary-btn">CHECK REGISTRY</button></div>
        ${send.resolved ? `<div class="notice teal-card"><strong>REGISTERED RECIPIENT</strong><span>B ${short(send.resolved.B[0].toString())}…<br>V ${short(send.resolved.V[0].toString())}…</span></div>` : ""}`
        : `<div class="notice teal-card"><strong>SELF BRIDGE</strong><span>The destination note will use the shielded address derived from this vault.</span></div>`}
      ${draft?.relayed || draft?.proof || recipientMode === "other" ? `<div class="notice ${draft?.relayed ? "teal-card" : "pink-card"}">
        <strong>${draft?.relayed ? "DELIVERED" : draft?.proof ? "PROOF READY" : "REGISTRY ADDRESS ONLY"}</strong>
        <span>${draft?.relayed
          ? `The note is bridging. The recipient finds it by scanning. You send them nothing, and you can close this tab.${txLink(draft.relayed.txHash ?? draft.relayed.hash, "l1", "VIEW L1 RELAY")}`
          : draft?.proof
            ? `C_dest ${short(draft.destNote.cDest.toString())}${copyButton(draft.destNote.cDest.toString(), "C_dest")} · bridging ${formatEther(draft.bridgedValue)} ETH after the relay fee.`
            : recipientMode === "self"
              ? "Only this vault's public shielded keys are used. Your private keys stay local."
              : "The L1 address must have published a shielded address in the registry. Private keys are never requested."}</span>
      </div>` : ""}
      ${state.busy && !draft?.proof ? provingNotice() : ""}
      <button id="action" class="primary" ${ready.length && send.destinationChosen && recipientReady && !draft?.relayed && !state.busy ? "" : "disabled"}>${action}</button>
      <div class="micro">self uses this vault　★　other users must be registered on L1</div>
    </section>`;
}

/** WITHDRAW. Keys are derived from the mnemonic and never typed. */
function receiveView() {
  const r = state.receive;
  const note = selectedNote();
  const scanning = state.noteProgress === "scan";
  const spendable = [...evmChains().map((chain) => chain.key), "starknet"].flatMap((chain) =>
    l2List(chain).filter((candidate) => candidate.status === "spendable").map((candidate) => ({ ...candidate, chain })),
  );
  const scanNotice = typeof state.notice === "string" && state.notice.startsWith("Scan complete.")
    ? state.notice.replace(/^Scan complete\.\s*/, "")
    : null;
  const noteOption = (candidate) => `<label class="bridge-option note-option" data-pick-l2="${candidate.id}">
    <input type="radio" name="withdraw-note" value="${candidate.id}" ${String(r.selected) === candidate.id ? "checked" : ""} />
    <span class="bridge-option-icon route-${chainBrand(candidate.chain, chainLabel(candidate.chain))}">${escapeHtml(candidate.chain === "starknet" ? "SN" : chainInitials(chainLabel(candidate.chain)))}</span>
    <span><b>${formatEther(BigInt(candidate.value))} ETH</b><small>${escapeHtml(chainLabel(candidate.chain))} · ${short(candidate.id)}</small></span>
    <span class="pill ok">SPENDABLE</span>
  </label>`;
  const st = r.status?.state;
  const action = state.busy
    ? (r.proof ? "SUBMITTING WITHDRAWAL…" : st === "activated" ? "PROVING… THIS CAN TAKE A MINUTE" : "WORKING…")
    : r.response ? "WITHDRAWN ✓"
    : r.proof ? "SUBMIT L2 WITHDRAWAL →"
    : st === "activated" ? "GENERATE L2 PROOF →"
    : st === "received-pending-activation" ? "REFRESH ACTIVATION →"
    : note ? "REFRESH STATUS →"
    : "SELECT A NOTE";

  return `
    <section class="panel flow-panel">
      ${flowHead("L2 · DESTINATION", "WITHDRAW A NOTE", "Scan for notes addressed to you, choose a spendable note below, then land it in your account.")}
      ${withdrawFlowDiagram(note)}
      ${scanNotice ? "" : noticeView()}
      ${scanning
        ? `<div class="notice pink-card withdraw-scan-loader" role="status" aria-live="polite"><strong>${progressLabel(true, "", "SCANNING VAULT")}</strong><span>Checking the Vault's L1 and destination routes. Spendable notes will appear here when the scan finishes.</span></div>`
        : `<div class="notice pink-card"><strong>${scanNotice ? "SCAN COMPLETE" : r.scannedCount ? `SCANNED ${r.scannedCount} NOTE${r.scannedCount === 1 ? "" : "S"}` : "VAULT NOT SCANNED YET"}</strong><span>${scanNotice ? `${escapeHtml(scanNotice)} ${spendable.length} spendable now.` : r.scanned.length ? `${r.scanned.length} addressed to you · ${spendable.length} spendable now.` : "Use SCAN in the Vault to refresh notes. Matching happens only in this browser; the relayer never learns which note is yours."}</span></div>
          <fieldset class="bridge-choice note-choice"><legend>SPENDABLE L2 NOTES</legend>
            ${spendable.length ? spendable.map(noteOption).join("") : `<div class="note-empty">No spendable L2 notes.<br><span>Use SCAN in the Vault to refresh destination confirmations.</span></div>`}
          </fieldset>`}
      ${note ? `
        <div class="flow-step active"><span class="flow-number">▸</span><div><span class="eyebrow">SELECTED</span><h3>${formatEther(note.value)} ETH · ${chainLabel(note.chain)}</h3><p>${statusLabel(st)}</p></div></div>
        <label class="input-label">FINAL RECIPIENT ${note.chain === "starknet" ? "(STARKNET FELT252)" : "ADDRESS"}<input id="recv-recipient" placeholder="${note.chain === "starknet" ? "0x… or decimal felt252" : "0x… where the funds actually land"}" value="${escapeHtml(r.recipient)}" autocomplete="off" spellcheck="false" />${fieldProblemSlot("recv-recipient-problem", recipientProblem(r.recipient, note.chain))}</label>`
        : ""}
      <div class="notice ${r.response ? "teal-card" : "pink-card"}">
        <strong>${r.response ? "FUNDS RELEASED" : r.proof ? "L2 PROOF READY" : "AUTOMATIC ACTIVATION"}</strong>
        <span>${r.response ? `The destination pool released the note to your address.${txLink(r.response.hash ?? r.response.txHash, note?.chain, "VIEW WITHDRAWAL")}`
          : r.proof ? "Proved locally. F5 submits the final withdrawal and pays the gas."
          : "Once bridge backing lands, F5 activates the note automatically. No recipient key material or user transaction is needed."}</span>
      </div>
      ${state.busy && !r.proof && st === "activated" ? provingNotice() : ""}
      <button id="action" class="primary" ${note && !r.response && !state.busy ? "" : "disabled"}>${action}</button>
      <div class="micro">keys derived from your phrase　★　notes are found, not announced</div>
    </section>`;
}

/**
 * RAGEQUIT. This deliberately sits outside the normal withdrawal language: it
 * is a public, depositor-paid emergency exit and must never look private.
 */
function ragequitView() {
  const r = state.ragequit;
  const accountKey = ragequitAccountKey(state.account);
  const fresh = r.checkedFor === accountKey;
  const partitioned = partitionRagequitNotes(state.notes, r.eligibility, state.account);
  const available = fresh ? partitioned.eligible : [];
  const mismatched = fresh ? partitioned.mismatched : [];
  const selected = available.find((note) => note.commitment === r.noteCommitment) ?? available[0];
  const confirmed = hasRagequitConsent(r, selected?.commitment);
  const checking = state.noteProgress === "ragequit-check";
  const noteOption = (note) => `<label class="bridge-option note-option emergency-note">
    <input type="radio" name="ragequit-note" value="${note.commitment}" ${selected?.commitment === note.commitment ? "checked" : ""} />
    <span class="bridge-option-icon">!</span>
    <span><b>${formatEther(BigInt(note.value))} ETH</b><small>${note.legacy ? "legacy" : `#${note.index}`} · ${short(note.commitment)}</small></span>
    <span class="pill danger">PUBLIC EXIT</span>
  </label>`;
  const action = checking ? "CHECKING DEPOSITOR…"
    : state.busy ? (r.proof ? "SUBMITTING RAGEQUIT…" : "PROVING… THIS CAN TAKE A MINUTE")
    : r.response ? "RAGEQUIT COMPLETE ✓"
    : r.proof ? "SUBMIT PUBLIC RAGEQUIT →"
    : "GENERATE RAGEQUIT PROOF →";
  const canAct = selected && state.account && fresh && confirmed && !r.response && !state.busy;
  const connectedBalance = r.balance === null ? null : BigInt(r.balance);

  return `
    <section class="panel flow-panel ragequit-panel">
      ${flowHead("L1 · EMERGENCY ONLY", "PUBLIC RAGEQUIT", "Exit an L1 note without ASP approval. Use this only when the normal private path is unavailable.")}
      ${noticeView()}
      <div class="notice error-card ragequit-warning" role="alert">
        <strong>THIS DESTROYS YOUR PRIVACY</strong>
        <span>The transaction permanently links your original deposit address, this commitment, and the amount returned. It is public and irreversible.</span>
      </div>
      <div class="ragequit-account">
        <span><b>CONNECTED ADDRESS</b><code>${state.account ? escapeHtml(state.account) : "not connected"}</code></span>
        <span><b>L1 GAS BALANCE</b><code>${connectedBalance === null ? "not checked" : `${formatEther(connectedBalance)} ETH`}</code></span>
        <button id="refresh-ragequit" class="secondary-btn" ${state.busy ? "disabled" : ""}>${checking ? "CHECKING…" : "CHECK ON-CHAIN"}</button>
      </div>
      ${state.account && connectedBalance === 0n ? `<div class="notice error-card"><strong>GAS REQUIRED</strong><span>The original depositor address has no ETH. Ragequit has no relayer path, so this address must hold enough ETH to pay L1 gas.</span></div>` : ""}
      ${fresh && mismatched.length ? `<div class="notice error-card address-mismatch"><strong>WRONG DEPOSITOR ADDRESS</strong><span>${mismatched.map((note) => `${formatEther(BigInt(note.value))} ETH note requires ${escapeHtml(noteEligibilityAddress(note))}`).join("<br>")}<br>Connect the required original depositor EOA. A different wallet cannot ragequit the note.</span></div>` : ""}
      <fieldset class="bridge-choice note-choice"><legend>ELIGIBLE L1 NOTES · VERIFIED FROM POOL</legend>
        ${checking ? `<div class="note-empty">Reading depositors and nullifiers from the L1 pool…</div>`
          : available.length ? available.map(noteOption).join("")
          : `<div class="note-empty">${!state.account ? "Connect the original depositor EOA, then check on-chain." : fresh ? "No unspent notes belong to this connected depositor." : "Check on-chain to find eligible notes."}</div>`}
      </fieldset>
      ${r.proof && selected ? `<div class="notice pink-card"><strong>PROOF READY</strong><span>The proof was generated locally. Submitting it will reveal the selected note and return ${formatEther(BigInt(selected.value))} ETH to ${escapeHtml(state.account)}.</span></div>` : ""}
      <label class="confirm-row ragequit-confirm"><input type="checkbox" id="ragequit-confirm" ${confirmed ? "checked" : ""} ${!selected || r.response ? "disabled" : ""} /> I understand this publicly links my deposit address and amount, burns the selected note, and cannot be undone.</label>
      ${state.busy && !checking && !r.proof ? provingNotice() : ""}
      <button id="action" class="primary danger-action" ${canAct ? "" : "disabled"}>${action}</button>
      <div class="micro">no relayer ★ original depositor pays L1 gas ★ remains available after pool wind-down</div>
    </section>`;
}

/**
 * ACTIVITY. One chronological record of what this vault has done.
 *
 * Everything here is reconstructed from caches the app already keeps, so it is
 * exactly as complete as those caches: a note recovered from chain events carries
 * no local timestamp, and its row says so rather than inventing one.
 */
function activityView() {
  const entries = buildActivity(state.notes, state.withdrawn, chainLabel);
  const kindColor = { deposit: "ethereum", bridge: "optimism", withdraw: "starknet", ragequit: "muted" };
  const kindIcon = { deposit: "↓", bridge: "→", withdraw: "↑", ragequit: "!" };

  const row = (entry) => {
    const age = relativeTime(entry.at);
    return `
      <div class="vnote activity-row ${entry.kind === "ragequit" ? "is-public" : ""}">
        <span class="note-icon route-${kindColor[entry.kind] ?? "ethereum"}" aria-hidden="true">${entry.kind === "deposit" || entry.kind === "withdraw" || entry.kind === "bridge" ? kindIcon[entry.kind] : "!"}</span>
        <div>
          <strong>${escapeHtml(entry.title)} · ${formatEther(BigInt(entry.value))} ETH</strong>
          <small>${escapeHtml(entry.detail)}</small>
          ${entry.hash ? txLink(entry.hash, entry.kind === "withdraw" ? entry.chain : "l1") : ""}
        </div>
        <span class="activity-age">${age ? escapeHtml(age) : "UNDATED"}</span>
      </div>`;
  };

  return `
    <section class="panel flow-panel">
      ${flowHead("VAULT · RECORD", "ACTIVITY", "Every deposit, bridge, withdrawal, and public exit this vault knows about, newest first.")}
      ${noticeView()}
      <div class="activity-list">
        ${entries.length
          ? entries.map(row).join("")
          : `<div class="note-empty">Nothing has happened yet.<br><span>Deposit to start, or run SCAN to rebuild from the chain.</span></div>`}
      </div>
      <div class="micro">rebuilt from this vault's local caches　★　a recovered note has no local timestamp</div>
    </section>`;
}

function noteEligibilityAddress(note) {
  return state.ragequit.eligibility[note.commitment]?.depositor ?? "unknown address";
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
  return `<div class="notice teal-card dismissible-notice" role="status"><button type="button" class="notice-dismiss" data-dismiss-notice aria-label="Dismiss note">×</button><strong>NOTE</strong><span class="pre">${escapeHtml(state.notice)}</span>${state.noticeTx ?? ""}</div>`;
}

/**
 * Shown while a proof is being generated, in the frame `guard` yields before the
 * work starts.
 *
 * This is a warning, not a progress indicator, and it cannot be anything else:
 * snarkjs runs the witness and proof on the main thread, so for the next tens of
 * seconds no timer fires and no pixel repaints. An elapsed counter here would
 * simply freeze at 0 and read as a hang. Naming the freeze in advance is the only
 * honest signal available until proving moves to a Worker.
 */
function provingNotice() {
  return `<div class="notice pink-card proving-notice" role="status" aria-live="polite">
    <strong>PROVING LOCALLY</strong>
    <span>This runs in your browser and takes up to a minute. The tab will stop responding while it does — that is expected. Do not close it.</span>
  </div>`;
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
    : st === "received-pending-activation" ? "bridged · relayer activation pending"
    : st === "bridge-pending" ? "bridged on L1 · awaiting confirmation on L2"
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
    out.push({
      id,
      value: n.value.toString(),
      status: state.withdrawn[id] ? "withdrawn" : (n._status ?? "activate"),
      bridgedAt: n.bridgedAt ?? null,
    });
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

/**
 * Surface a self-bridge as soon as its L1 relay succeeds. The encrypted cache
 * already stores the recipient's spend material, so the note can be upgraded
 * in place when a later scan observes it on the destination.
 */
async function rememberPendingSelfBridge(draft) {
  if (!draft.selfNote) return;
  const pending = {
    ...draft.selfNote,
    chain: destinationKey(draft.withdrawal.chainId),
    _status: "pending",
    bridgedAt: Date.now(),
  };
  const id = String(pending.cDest);
  const existing = state.receive.scanned.findIndex(
    (note) => note.chain === pending.chain && String(note.cDest) === id,
  );
  if (existing < 0) state.receive.scanned.push(pending);
  else if (state.receive.scanned[existing]._status === "pending") state.receive.scanned[existing] = pending;
  state.receive.scannedCount = Math.max(state.receive.scannedCount, state.receive.scanned.length);
  await saveL2Scan(state.identity.vaultKey, state.config.scope, {
    notes: state.receive.scanned,
    scannedCount: state.receive.scannedCount,
  });
}

/*//////////////////////////////////////////////////////////////
                        HELPERS / STATE
//////////////////////////////////////////////////////////////*/

function captureForm() {
  const read = (id) => app.querySelector(id)?.value;
  const set = (obj, key, value) => { if (value !== undefined) obj[key] = value; };
  set(state.send, "noteCommitment", app.querySelector('input[name="send-note"]:checked')?.value);
  set(state.send, "destinationChainId", app.querySelector('input[name="send-chain"]:checked')?.value);
  set(state.send, "recipientMode", app.querySelector('input[name="send-recipient-mode"]:checked')?.value);
  set(state.send, "recipientKey", read("#send-recipient"));
  set(state.receive, "recipient", read("#recv-recipient"));
  set(state.ragequit, "noteCommitment", app.querySelector('input[name="ragequit-note"]:checked')?.value);
  const ragequitConfirmed = app.querySelector("#ragequit-confirm");
  if (ragequitConfirmed) {
    state.ragequit.confirmedCommitment = ragequitConfirmed.checked ? state.ragequit.noteCommitment : "";
  }
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
  saveFormDraft();
}

/**
 * Form state that survives a reload, in the same tab-scoped storage as the
 * unlocked session.
 *
 * A bridge takes a note choice, a destination, and a recipient before it takes a
 * minute of proving — losing all of that to a stray refresh means re-entering it
 * from memory. Only the user's *choices* are kept.
 *
 * The draft proof is deliberately excluded: it carries the selected note's
 * nullifier and secret, and the vault's rule is that spend material lives in the
 * encrypted cache or nowhere. A restored form re-proves; it never resumes a proof.
 */
const FORM_DRAFT_KEY = "f5-form-draft-v1";

function saveFormDraft() {
  if (!state.identity) return;
  try {
    sessionStorage.setItem(FORM_DRAFT_KEY, JSON.stringify({
      version: 1,
      amount: state.amount,
      send: {
        noteCommitment: state.send.noteCommitment,
        destinationChainId: state.send.destinationChainId,
        destinationChosen: state.send.destinationChosen,
        recipientMode: state.send.recipientMode,
        recipientKey: state.send.recipientKey,
      },
      receive: { recipient: state.receive.recipient, selected: state.receive.selected },
    }));
  } catch { /* Storage can be unavailable in hardened browser modes. */ }
}

function restoreFormDraft() {
  let draft;
  try {
    draft = JSON.parse(sessionStorage.getItem(FORM_DRAFT_KEY) ?? "null");
  } catch {
    return;
  }
  if (draft?.version !== 1) return;
  if (typeof draft.amount === "string" && draft.amount) state.amount = draft.amount;
  Object.assign(state.send, draft.send ?? {});
  Object.assign(state.receive, draft.receive ?? {});
  // `captureForm` snapshots before the radio handler sets this, so the stored flag
  // can trail the stored chain id by one interaction. It is derivable, so derive it
  // rather than restoring a form whose destination reads chosen and acts unchosen.
  state.send.destinationChosen = Boolean(state.send.destinationChainId);
}

function clearFormDraft() {
  try { sessionStorage.removeItem(FORM_DRAFT_KEY); } catch { /* best effort */ }
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
/**
 * A copy affordance for a value the UI only ever shows truncated. Without this a
 * commitment is visible but unrecoverable — there is no other path to the full
 * digits, which is exactly what a user needs when a note looks stuck.
 */
/**
 * A slot for an inline field problem, updated in place as the user types.
 *
 * Written straight to the DOM rather than through `render()` on purpose: a full
 * re-render on every keystroke would rebuild the input and throw away the caret
 * position mid-word.
 */
function fieldProblemSlot(id, problem) {
  return `<small class="field-problem" id="${id}" role="alert">${escapeHtml(problem)}</small>`;
}

/** Is the user actively typing into a field right now? */
function isEditing(element) {
  if (!element || !app.contains(element)) return false;
  const tag = element.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function showFieldProblem(id, problem) {
  const slot = app.querySelector(`#${id}`);
  if (slot) slot.textContent = problem;
}

function copyButton(value, label = "Value") {
  if (!value) return "";
  return `<button type="button" class="copy-chip" data-copy="${escapeHtml(value)}" data-copy-label="${escapeHtml(label)}" title="Copy ${escapeHtml(label.toLowerCase())}" aria-label="Copy ${escapeHtml(label.toLowerCase())}">COPY</button>`;
}
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
 * On-chain nullifier hash of an L1 note: `Poseidon([nullifier])` — exactly the
 * `existingNullifierHash` the withdrawal circuit exposes (commitmentL1.circom) and
 * the value the pool records in its spent set.
 */
function nullifierHashOf(nullifier) {
  return poseidon1([BigInt(nullifier)]).toString();
}

/**
 * Reconcile the local `spent` cache against the pool's burned-nullifier set.
 *
 * `status` only flips to "spent" after a successful relay in the SAME session that
 * spent the note (see runSend). A note spent on another device, or one rebuilt by
 * a scan recovery (which walks public deposits and cannot tell spent from live), otherwise
 * stays "ready" and gets offered for a spend the pool rejects with
 * NullifierAlreadySpent. This is the on-chain correction.
 *
 * Best-effort: a failed sweep leaves the cache untouched rather than blocking the
 * user. Returns the number of notes newly marked spent.
 */
async function reconcileSpentNotes() {
  if (!state.identity || !state.config?.scope) return 0;
  let spentSet;
  try {
    const response = await fetch("/api/l1/spent-nullifiers");
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "spent-nullifier index unavailable");
    spentSet = new Set((body.nullifiers ?? []).map(String));
  } catch (error) {
    console.warn("[reconcile] spent-nullifier check skipped:", error);
    return 0;
  }
  let changed = 0;
  for (const note of state.notes) {
    if (note.status === "spent" || note.nullifier == null) continue;
    if (spentSet.has(nullifierHashOf(note.nullifier))) {
      note.status = "spent";
      changed += 1;
    }
  }
  if (changed) await saveNotes(state.identity.vaultKey, state.config.scope, state.notes);
  return changed;
}

/**
 * Read ragequit authority from the pool for every locally known live note.
 * Labels can survive partial withdrawals, so local note provenance is not an
 * authority signal; `depositors(label)` is the source of truth.
 */
async function refreshRagequitEligibility() {
  if (!state.identity) throw new Error("Unlock your vault first.");
  if (!state.config?.poolAddress) throw new Error("POOL_ADDRESS is not configured on the API.");

  const r = state.ragequit;
  r.checkedFor = null;
  r.balance = null;
  const client = readClient();
  const ready = state.notes.filter((note) => note.status !== "spent");
  const entries = await Promise.all(ready.map(async (note) => {
    const [depositor, spent] = await Promise.all([
      client.readContract({
        address: state.config.poolAddress,
        abi: poolAbi,
        functionName: "depositors",
        args: [BigInt(note.label)],
      }),
      client.readContract({
        address: state.config.poolAddress,
        abi: poolAbi,
        functionName: "nullifierHashes",
        args: [BigInt(nullifierHashOf(note.nullifier))],
      }),
    ]);
    return [note.commitment, { depositor, spent: Boolean(spent) }];
  }));

  r.eligibility = Object.fromEntries(entries);
  r.checkedFor = ragequitAccountKey(state.account);
  r.balance = state.account ? (await client.getBalance({ address: state.account })).toString() : null;

  let changed = false;
  for (const note of ready) {
    if (r.eligibility[note.commitment]?.spent) {
      note.status = "spent";
      changed = true;
    }
  }
  if (changed) await saveNotes(state.identity.vaultKey, state.config.scope, state.notes);

  const eligible = state.notes.filter((note) => note.status !== "spent" && state.account
    && r.eligibility[note.commitment]?.depositor?.toLowerCase() === state.account.toLowerCase());
  if (!eligible.some((note) => note.commitment === r.noteCommitment)) {
    selectRagequitNote(r, eligible[0]?.commitment);
  }
}

function invalidateRagequitAuthorization({ clearEligibility = false } = {}) {
  const r = state.ragequit;
  r.confirmedCommitment = "";
  r.proof = null;
  r.response = null;
  r.checkedFor = null;
  r.balance = null;
  if (clearEligibility) r.eligibility = {};
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
  if (ragequitAccountKey(account) !== ragequitAccountKey(state.account)) {
    invalidateRagequitAuthorization({ clearEligibility: true });
  }
  state.account = account;
  state.registered = state.identity && cachedPublicationStatus(localStorage, account, state.identity.shielded) ? true : null;
  await refreshWalletBalance();
  await checkRegistration();
  if (state.identity && state.view === "ragequit") await refreshRagequitEligibility();
}

/**
 * Gas held back by MAX. The pool's Merkle insert dominates the deposit, so this is
 * budgeted generously: overshooting costs the user a little unspent headroom, while
 * undershooting hands them a transaction their balance cannot pay for.
 */
const DEPOSIT_GAS_BUDGET = 400_000n;

/** Read the connected wallet's L1 balance. Best-effort: a failure just hides MAX. */
async function refreshWalletBalance() {
  if (!state.account || !state.config) {
    state.walletBalance = null;
    return;
  }
  try {
    state.walletBalance = (await readClient().getBalance({ address: state.account })).toString();
  } catch {
    state.walletBalance = null;
  }
}

/** The largest depositable amount: balance less a reserve for the deposit's own gas. */
async function maxDepositAmount() {
  await refreshWalletBalance();
  if (state.walletBalance === null) throw new Error("Connect a wallet to read your balance.");

  let gasPrice = 0n;
  try {
    gasPrice = await readClient().getGasPrice();
  } catch { /* Fall back to a flat reserve rather than failing the button. */ }
  const balance = BigInt(state.walletBalance);
  const reserve = gasPrice > 0n ? gasPrice * DEPOSIT_GAS_BUDGET * 2n : parseEther("0.002");
  if (balance <= reserve) throw new Error(`Balance does not cover a deposit plus ${state.config.chainName} gas.`);
  return floorEther(balance - reserve);
}

/**
 * Format wei as ETH truncated — never rounded — to `decimals` places.
 *
 * Rounding up here would put a number above the wallet balance into the amount
 * field, so the deposit would fail the balance check it was meant to satisfy.
 */
function floorEther(wei, decimals = 6) {
  const text = formatEther(wei);
  if (!text.includes(".")) return text;
  const [whole, frac] = text.split(".");
  const kept = frac.slice(0, decimals).replace(/0+$/, "");
  return kept ? `${whole}.${kept}` : whole;
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

async function copyValue(label, value) {
  if (!value) throw new Error(`No ${String(label || "value").toLowerCase()} is available to copy.`);
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
  } else {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    if (!copied) throw new Error(`Could not copy the ${String(label || "value").toLowerCase()}.`);
  }
  state.notice = `${label || "Value"} copied.`;
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
  rememberUnlockedSession(mnemonic);
  state.setup = null;
  state.notice = notice;
  await afterUnlock();
}

async function unlockIdentity(kind) {
  const unwrap = kind === "password"
    ? { kind: "password", password: state.unlockPassword }
    : { kind: "wallet", signature: await signIdentityMessage() };
  const mnemonic = await loadMnemonic(unwrap);
  await adoptMnemonic(mnemonic);
  rememberUnlockedSession(mnemonic);
  state.unlockPassword = "";
  await afterUnlock();
}

/**
 * Keep the decrypted identity only for this browser tab. sessionStorage survives
 * reloads but is cleared when the tab closes, preserving the vault's encrypted-at-rest boundary.
 */
function rememberUnlockedSession(mnemonic) {
  try {
    sessionStorage.setItem(UNLOCKED_SESSION_KEY, JSON.stringify({ version: 1, mnemonic }));
  } catch { /* Storage can be unavailable in hardened browser modes. */ }
}

function unlockedSessionMnemonic() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(UNLOCKED_SESSION_KEY) ?? "null");
    return stored?.version === 1 && typeof stored.mnemonic === "string" ? stored.mnemonic : null;
  } catch {
    return null;
  }
}

function clearUnlockedSession() {
  try { sessionStorage.removeItem(UNLOCKED_SESSION_KEY); } catch { /* best effort */ }
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
  const l2Scan = await loadL2Scan(state.identity.vaultKey, scope);
  state.receive.scanned = l2Scan.notes;
  state.receive.scannedCount = l2Scan.scannedCount;
  state.receive.index = {};
  state.withdrawn = await loadL2History(state.identity.vaultKey, scope);
  state.registered = cachedPublicationStatus(localStorage, state.account, state.identity.shielded) ? true : null;

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

  // Correct the note cache against the chain without blocking the unlock — a note
  // spent on another device reads "ready" until this lands. Re-render on a change.
  reconcileSpentNotes().then((changed) => { if (changed) render(); }).catch(() => {});

  await checkRegistration();
}

/*//////////////////////////////////////////////////////////////
                       ERC-6538 REGISTRY
//////////////////////////////////////////////////////////////*/

async function checkRegistration() {
  if (!state.identity || !state.account || !state.config?.rpcUrl) return;
  const cached = cachedPublicationStatus(localStorage, state.account, state.identity.shielded);
  if (cached) state.registered = true;
  try {
    const { SHIELDED_SCHEME_ID, ERC6538_REGISTRY, encodeShieldedMetaAddress } = await sdk();
    const stored = await readClient().readContract({
      address: ERC6538_REGISTRY, abi: REGISTRY_ABI, functionName: "stealthMetaAddressOf",
      args: [state.account, SHIELDED_SCHEME_ID],
    });
    const mine = encodeShieldedMetaAddress(state.identity.shielded);
    state.registered = stored?.toLowerCase() === mine.toLowerCase();
    storePublicationStatus(localStorage, state.account, state.identity.shielded, state.registered);
  } catch {
    state.registered = cached ? true : null;
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
  storePublicationStatus(localStorage, state.account, state.identity.shielded, true);
  state.notice = "Shielded address published. Senders can now resolve it from your address.";
  state.noticeTx = txLink(hash, "l1");
}

/** Resolve either this vault or another user's registered L1 address. */
async function resolveRecipient() {
  captureForm();
  if (state.send.recipientMode !== "other") {
    if (!state.identity?.shielded) throw new Error("Unlock your vault first.");
    const { B, V } = state.identity.shielded;
    state.send.resolved = { B, V };
    return;
  }

  const input = (state.send.recipientKey ?? "").trim();
  if (!input) throw new Error("Enter the recipient's registered L1 address.");
  if (!isAddress(input)) throw new Error("Enter a valid L1 address beginning with 0x.");
  const { SHIELDED_SCHEME_ID, ERC6538_REGISTRY, decodeShieldedMetaAddress } = await sdk();
  const stored = await readClient().readContract({
    address: ERC6538_REGISTRY, abi: REGISTRY_ABI, functionName: "stealthMetaAddressOf",
    args: [input, SHIELDED_SCHEME_ID],
  });
  if (!stored || stored === "0x") {
    throw new Error("That L1 address is not registered. Ask the recipient to publish their shielded address first.");
  }
  state.send.resolved = decodeShieldedMetaAddress(stored);
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

  // Preserve local-only fields: recovery walks public deposits and cannot tell a
  // spent note from a live one, nor when or in which transaction it moved. Rebuilding
  // from the chain alone would resurrect spent notes AND silently drop every local
  // annotation (`spentTo`, `spentBy`, `ragequitHash`, the activity timestamps) on
  // every single scan.
  const prev = new Map(state.notes.map((n) => [n.commitment, n]));
  const recovered = recoverNotes(state.identity.mnemonic, BigInt(state.config.scope), deposits).map((n) => {
    const commitment = n.commitment.toString();
    const local = prev.get(commitment);
    return {
      ...local,
      index: n.index.toString(),
      commitment,
      label: n.label.toString(),
      value: n.value.toString(),
      nullifier: n.nullifier.toString(),
      secret: n.secret.toString(),
      status: local?.status ?? "ready",
    };
  });

  // Keep legacy (non-derivable) notes; they can never be recovered this way.
  const legacy = state.notes.filter((n) => n.legacy);
  state.notes = [...recovered, ...legacy];
  await saveNotes(state.identity.vaultKey, state.config.scope, state.notes);

  // Recovery walks public deposits and cannot tell a spent note from a live one, so
  // every rebuilt note defaults to "ready". Correct that against the pool's burned
  // nullifiers before the user is shown spendable notes that would be rejected.
  const spent = await reconcileSpentNotes();
  return {
    recoveredCount: recovered.length,
    depositsCount: deposits.length,
    spent,
    detail: `${recovered.length} note${recovered.length === 1 ? "" : "s"} recovered from ${deposits.length} deposit${deposits.length === 1 ? "" : "s"}`
      + `${spent ? ` · ${spent} spent` : ""}`,
  };
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
async function scanForNotes({ only = null, quiet = false } = {}) {
  if (!state.identity) throw new Error("Unlock your vault first.");

  const r = state.receive;
  const previousScanned = r.scanned;
  const previousScannedCount = r.scannedCount;
  const previousIndex = r.index;
  r.scanned = [];
  r.scannedCount = 0;
  // A partial scan must keep the indexes it is not refreshing: `prepareL2Proof`
  // reads `r.index[chain]`, so dropping an untouched chain's index would force a
  // needless refetch at proving time.
  r.index = only ? Object.fromEntries(Object.entries(previousIndex).filter(([chain]) => !only.includes(chain))) : {};
  if (!quiet) state.notice = null;

  let noteService = null;
  const scanL2 = async (chain, path) => {
    const feed = await fetchIndex(chain, path);
    if (feed.error) throw new Error(feed.error);
    if (!feed.index?.configured) return { status: "skipped", detail: "Destination is not configured" };

    if (!noteService) {
      const { NoteService } = await sdk();
      noteService = new NoteService();
    }
    r.index[feed.chain] = feed.index;
    const candidates = (feed.index.candidates ?? []).map((note) => ({
      commitment: BigInt(note.commitment),
      value: BigInt(note.value),
      ephemeralKey: note.ephemeralKey.map(BigInt),
      viewTag: note.viewTag,
    }));
    r.scannedCount += candidates.length;
    let found = 0;
    // Matching remains entirely in this browser. Only after this route has been
    // fetched and matched does the sequential runner begin the next route.
    for (const note of noteService.scanL2Notes(candidates, state.identity.shielded)) {
      r.scanned.push({ ...note, chain: feed.chain, _status: deriveL2Status(note, feed.index) });
      found += 1;
    }
    return {
      candidates: candidates.length,
      found,
      detail: `${candidates.length} candidate${candidates.length === 1 ? "" : "s"} · ${found} yours`,
    };
  };

  // The ordering here is deliberate: L1 recovery/reconciliation always settles
  // first, then configured EVM destinations in server order, then Starknet. The
  // runner awaits each route and never fans these requests out with Promise.all.
  const configuredEvmChains = evmChains();
  const routes = [
    {
      key: "l1",
      label: "L1 · Ethereum",
      icon: "Ξ",
      color: "ethereum",
      scanningDetail: "Reading deposits and rebuilding phrase-derived notes…",
      continueOnError: true,
      run: recoverL1Notes,
    },
    ...configuredEvmChains.map((chain) => ({
      key: chain.key,
      label: `L2 · ${chain.chainName}`,
      icon: chainInitials(chain.chainName),
      color: chainBrand(chain.key, chain.chainName),
      scanningDetail: `Fetching ${chain.chainName} note index…`,
      continueOnError: true,
      run: () => scanL2(chain.key, `/api/l2/${chain.key}/index`),
    })),
    // Include Starknet while its separate config request is still pending; the
    // index endpoint will report "skipped" if it is actually unconfigured.
    ...(state.starknet?.configured !== false ? [{
      key: "starknet",
      label: "L2 · Starknet",
      icon: "SN",
      color: "starknet",
      scanningDetail: "Fetching Starknet note index…",
      continueOnError: true,
      run: () => scanL2("starknet", "/api/starknet/index"),
    }] : []),
  ].filter((route) => !only || only.includes(route.key));

  if (!routes.length) return;

  // A quiet scan leaves the progress panel alone. It runs on a timer rather than a
  // click, so painting a step list nobody asked for would flash the rail on its own.
  if (!quiet) {
    state.scanProgress = {
      active: true,
      steps: routes.map((route) => ({
        key: route.key,
        label: route.label,
        icon: route.icon,
        color: route.color,
        status: "pending",
        detail: "Waiting for the previous route",
      })),
    };
  }

  let results;
  try {
    results = await runSequentialScan(routes, {
      async onStep(route, update) {
        if (quiet) return;
        const step = state.scanProgress.steps.find((candidate) => candidate.key === route.key);
        if (step) Object.assign(step, update);
        render();
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    });
  } finally {
    if (!quiet) state.scanProgress.active = false;
  }

  const failures = results.filter((result) => result.status === "error");
  const completed = results.filter((result) => result.status === "complete");
  if (!completed.length) {
    r.scanned = previousScanned;
    r.scannedCount = previousScannedCount;
    throw new Error(failures.map(({ step, error }) => `${step.label}: ${describeError(error)}`).join(" · ") || "Scan could not start.");
  }

  // Carry over everything this pass could not speak for: notes on routes that
  // failed or were never visited, and in-flight self-bridges the destination
  // cannot see yet. See `preservedNotes` for why each case exists.
  r.scanned.push(...preservedNotes({
    previous: previousScanned,
    fresh: r.scanned,
    refreshedRoutes: completed.map(({ step }) => step.key),
  }));
  r.scannedCount = Math.max(r.scannedCount, previousScannedCount, r.scanned.length);
  if (r.selected && !selectedNote()) r.selected = null;
  if (state.config?.scope) {
    await saveL2Scan(state.identity.vaultKey, state.config.scope, {
      notes: r.scanned,
      scannedCount: r.scannedCount,
    });
  }
  if (quiet) return;
  const l2Count = Object.keys(r.index).length;
  const summary = r.scanned.length
    ? `Scan complete. Found ${r.scanned.length} note${r.scanned.length === 1 ? "" : "s"} across your L2 routes.`
    : l2Count
      ? `Scan complete. Refreshed L1 and checked ${r.scannedCount} L2 candidate${r.scannedCount === 1 ? "" : "s"} across ${l2Count} route${l2Count === 1 ? "" : "s"}; no notes found.`
      : "Scan complete. L1 is refreshed; no L2 destination is configured.";
  state.notice = failures.length
    ? `${summary} ${failures.length} route${failures.length === 1 ? "" : "s"} could not be scanned.`
    : summary;
}

/**
 * Re-scan only the destinations with a note still in flight.
 *
 * The timer that drives this used to re-render and nothing more, so it ticked the
 * ETA down while never asking whether the note had actually landed — a delivered
 * note kept reading AWAITING L2 until the user hit SCAN by hand. Refreshing just
 * the in-flight chains costs one index fetch per waiting route and lets the
 * pending state resolve itself.
 *
 * Deliberately outside `guard`: this is unprompted background work, so it must not
 * paint the workspace busy or disable the buttons under the user's cursor.
 */
let inFlightRefresh = false;

async function refreshInFlightRoutes() {
  if (!state.identity || state.busy || inFlightRefresh) return;
  // Never re-render under a user who is mid-entry. `render()` replaces the whole
  // tree, so a background refresh landing between two keystrokes would take the
  // focus and the caret with it.
  if (isEditing(document.activeElement)) return;
  const waiting = [...new Set(state.receive.scanned
    .filter((note) => note._status === "pending" || note._status === "activate")
    .map((note) => note.chain))];
  if (!waiting.length) return;

  inFlightRefresh = true;
  try {
    captureForm();
    await scanForNotes({ only: waiting, quiet: true });
    render();
  } catch (error) {
    // A background refresh that fails is not the user's problem — the note simply
    // keeps its last known state until the next tick or a manual SCAN.
    console.warn("[auto-refresh] in-flight route scan skipped:", error);
  } finally {
    inFlightRefresh = false;
  }
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
    else if (state.view === "ragequit") await runRagequit();
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

  const event = depositEventFromReceipt(receipt, config.poolAddress, precommitment);
  state.notes = [...state.notes, {
    index: index.toString(),
    commitment: event.commitment,
    label: event.label,
    value: event.value,
    nullifier: nullifier.toString(),
    secret: secret.toString(),
    status: "ready",
    // Local-only provenance for the activity log. The chain knows all of this, but
    // recovering it would mean a receipt lookup per note on every scan.
    depositedAt: Date.now(),
    depositHash: hash,
  }];
  await saveNotes(state.identity.vaultKey, state.config.scope, state.notes);
  state.notice = `Deposited ${formatEther(BigInt(event.value))} ${config.symbol} at index ${index}. Recoverable from your phrase.`;
  state.noticeTx = txLink(hash, "l1");
  await refreshWalletBalance();
  navigateVault("home", { replace: true, capture: false, clearMessages: false });
}

function depositEventFromReceipt(receipt, poolAddress, precommitment) {
  const [event] = parseEventLogs({
    abi: poolAbi,
    eventName: "Deposited",
    logs: receipt.logs.filter((log) => log.address.toLowerCase() === poolAddress.toLowerCase()),
    strict: true,
  });
  if (!event) {
    throw new Error("Deposit confirmed, but its pool event could not be decoded.");
  }
  if (event.args._precommitmentHash !== precommitment) {
    throw new Error("Deposit confirmed with an unexpected pool event.");
  }
  return {
    commitment: event.args._commitment.toString(),
    label: event.args._label.toString(),
    value: event.args._value.toString(),
  };
}

async function runSend() {
  const send = state.send;

  if (!send.destinationChosen || !send.destinationChainId) {
    throw new Error("Choose a bridge destination first.");
  }

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
    if (spent) {
      spent.status = "spent";
      spent.spentTo = String(draft.withdrawal.chainId);
      spent.spentAt = Date.now();
      spent.spentHash = result.txHash ?? result.hash ?? null;
    }
    await saveNotes(state.identity.vaultKey, state.config.scope, state.notes);
    await rememberPendingSelfBridge(draft);
    return;
  }

  if (!send.resolved) await resolveRecipient();
  const { B, V } = send.resolved;
  const selected = pickNote();
  if (!selected) throw new Error("No L1 note to spend.");
  // A tab open since before this note was spent elsewhere would build a valid proof
  // the relayer only rejects at `relay()` with NullifierAlreadySpent. Reconcile
  // against the chain first, then bail with a clear message. `selected` is a live
  // reference into `state.notes`, so reconcile flips its status in place.
  await reconcileSpentNotes();
  if (selected.status === "spent") {
    throw new Error("That note has already been spent. Run SCAN to refresh your notes.");
  }
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
      destinationChainId: send.destinationChainId,
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

  // A self-bridge can be represented in the encrypted L2 cache immediately
  // after the L1 relay. Derive the same recipient-side spend material a later
  // scan will return, but do not mark it spendable until L2 confirms it.
  const [selfNote] = send.recipientMode === "self"
    ? notes.scanL2Notes([{
        commitment: destNote.cDest,
        value: bridgedValue,
        ephemeralKey: destNote.ephemeralKey,
        viewTag: `0x${destNote.viewTag.toString(16).padStart(2, "0")}`,
      }], state.identity.shielded)
    : [];

  send.draft = { selected, destNote, selfNote, bridgedValue, withdrawal, feeCommitment: quote.feeCommitment, scope: state.config.scope, proof, relayed: null };
}

async function runRagequit() {
  const r = state.ragequit;
  if (!state.account) throw new Error("Connect the original depositor EOA first.");

  // Re-read immediately before both proving and submission. A stale tab must not
  // spend time proving a note that was burned elsewhere, or target the wrong EOA.
  await refreshRagequitEligibility();
  const selected = state.notes.find((note) => note.status !== "spent" && note.commitment === r.noteCommitment);
  if (!selected) throw new Error("Select an eligible, unspent L1 note.");
  if (!hasRagequitConsent(r, selected.commitment)) {
    throw new Error("Confirm the public, irreversible privacy warning for this selected note first.");
  }
  const eligibility = r.eligibility[selected.commitment];
  if (!eligibility || eligibility.depositor.toLowerCase() !== state.account.toLowerCase()) {
    throw new Error(`Connect the original depositor EOA ${eligibility?.depositor ?? "recorded by the pool"}.`);
  }
  if (eligibility.spent) throw new Error("That note has already been spent. Run SCAN to refresh your vault.");
  if (BigInt(r.balance ?? 0) === 0n) {
    throw new Error("The original depositor address needs ETH to pay L1 gas; ragequit cannot use a relayer.");
  }

  if (!r.proof) {
    const proofAccount = state.account.toLowerCase();
    const proofCommitment = selected.commitment;
    const { Circuits, PrivacyPoolSDK } = await sdk();
    const pool = new PrivacyPoolSDK(new Circuits({ browser: true, baseUrl: `${window.location.origin}/api/circuits/` }));
    const proof = await pool.proveCommitment(
      BigInt(selected.value),
      BigInt(selected.label),
      BigInt(selected.nullifier),
      BigInt(selected.secret),
    );
    if (!(await pool.verifyCommitment(proof))) throw new Error("Ragequit proof verification failed.");
    if (state.account.toLowerCase() !== proofAccount || r.noteCommitment !== proofCommitment
      || !hasRagequitConsent(r, proofCommitment)) {
      throw new Error("The wallet or selected note changed while proving. Review the warning and try again.");
    }
    r.proof = { data: proof, account: proofAccount, commitment: proofCommitment };
    return;
  }

  if (r.proof.account !== state.account.toLowerCase() || r.proof.commitment !== selected.commitment) {
    r.proof = null;
    throw new Error("The prepared proof belongs to a different wallet or note. Review the warning and prove again.");
  }

  const client = readClient();
  const wallet = await walletClient();
  const { request } = await client.simulateContract({
    address: state.config.poolAddress,
    abi: poolAbi,
    functionName: "ragequit",
    args: [formatRagequitProof(r.proof.data)],
    account: state.account,
  });
  const hash = await wallet.writeContract(request);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("Ragequit transaction reverted.");

  selected.status = "spent";
  selected.spentBy = "ragequit";
  selected.ragequitHash = hash;
  selected.spentAt = Date.now();
  await saveNotes(state.identity.vaultKey, state.config.scope, state.notes);
  r.response = { hash };
  r.proof = null;
  r.eligibility[selected.commitment] = { ...eligibility, spent: true };
  state.notice = `Ragequit confirmed. ${formatEther(BigInt(selected.value))} ${state.config.symbol} returned publicly to ${state.account}.`;
  state.noticeTx = txLink(hash, "l1");
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
    await saveL2Scan(state.identity.vaultKey, state.config.scope, { notes: r.scanned, scannedCount: r.scannedCount });
    return;
  }

  await refreshSelectedStatus();
  const st = r.status?.state;

  if (st === "received-pending-activation") {
    state.notice = "The note is backed or still settling. The relayer activates it automatically; refresh again shortly.";
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

  let index = r.index?.[note.chain];
  if (!index) {
    const path = note.chain === "starknet" ? "/api/starknet/index" : `/api/l2/${note.chain}/index`;
    const feed = await fetchIndex(note.chain, path);
    if (feed.error) throw new Error(`Unable to refresh ${chainLabel(note.chain)}: ${feed.error}`);
    if (!feed.index?.configured) throw new Error(`${chainLabel(note.chain)} is not configured on this relayer.`);
    index = feed.index;
    r.index[note.chain] = index;
  }
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

async function boot() {
  const mnemonic = unlockedSessionMnemonic();
  if (mnemonic && hasIdentity()) {
    try {
      await adoptMnemonic(mnemonic);
      await afterUnlock();
      // Only after the caches are loaded: the restored choices point at notes that
      // `afterUnlock` is what puts back in `state`.
      restoreFormDraft();
    } catch {
      clearUnlockedSession();
      clearFormDraft();
      state.identity = null;
      state.notes = [];
      state.withdrawn = {};
    }
  } else if (mnemonic) {
    clearUnlockedSession();
    clearFormDraft();
  }
  render();
  if (state.identity && vaultViewFromPath(location.pathname) === "ragequit") {
    await guard(refreshRagequitEligibility, "ragequit-check");
  }
}

boot();
window.addEventListener("popstate", () => {
  render();
  if (state.identity && state.view === "ragequit") void guard(refreshRagequitEligibility, "ragequit-check");
});
if (window.ethereum?.on) {
  window.ethereum.on("accountsChanged", (accounts) => {
    state.account = accounts?.[0] ?? "";
    state.registered = state.identity && cachedPublicationStatus(localStorage, state.account, state.identity.shielded) ? true : null;
    invalidateRagequitAuthorization({ clearEligibility: true });
    render();
    if (state.identity) {
      void guard(async () => {
        await refreshWalletBalance();
        await checkRegistration();
        if (state.view === "ragequit") await refreshRagequitEligibility();
      }, state.view === "ragequit" ? "ragequit-check" : null);
    }
  });
  window.ethereum.on("chainChanged", () => {
    state.registered = state.identity && cachedPublicationStatus(localStorage, state.account, state.identity.shielded) ? true : null;
    invalidateRagequitAuthorization({ clearEligibility: true });
    render();
    if (state.identity && state.view === "ragequit") {
      void guard(refreshRagequitEligibility, "ragequit-check");
    }
  });
}
window.setInterval(() => { void refreshInFlightRoutes(); }, 60_000);
