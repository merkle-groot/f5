import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { cachedPublicationStatus, renderVaultIdentityControls, storePublicationStatus } from "./vault-identity.js";

const shielded = {
  B: [12345678901234567890n, 22345678901234567890n],
  V: [32345678901234567890n, 42345678901234567890n],
};

test("renders the holder address, recovery action, and publication rationale", () => {
  const html = renderVaultIdentityControls({ shielded, account: "0x1234", registered: true, busy: false });

  assert.match(html, /SHIELDED ADDRESS/);
  assert.match(html, /id="reveal-mnemonic"/);
  assert.match(html, /shielded address is published/i);
  assert.match(html, /private keys and recovery phrase stay local/i);
  assert.doesNotMatch(html, /id="register-keys"/);
  assert.match(html, /<code class="holder-address">0x1234<\/code>/);
  assert.match(html, /data-copy-shielded="0x1234"/);
});

// Raw B and V limbs are not a handle the user can act on: senders resolve the
// keys from the registry by L1 address, so printing them only adds noise the
// user might mistake for something to copy around.
test("keeps the raw Baby Jubjub limbs off the card", () => {
  const html = renderVaultIdentityControls({ shielded, account: "0x1234", registered: true, busy: false });

  assert.doesNotMatch(html, /SPENDING KEY|VIEWING KEY/);
  assert.doesNotMatch(html, /12345678901234567890/);
});

test("places the publication explanation below the heading and makes connect actionable", () => {
  const html = renderVaultIdentityControls({ shielded, account: "", registered: null, busy: false });
  assert.match(html, /data-connect-wallet/);
  assert.ok(html.indexOf("identity-note") < html.indexOf("credential-body"));
});

test("stores publication status for the exact wallet and shielded identity", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };

  storePublicationStatus(storage, "0xABCD", shielded, true);
  assert.equal(cachedPublicationStatus(storage, "0xabcd", shielded), true);
  assert.equal(cachedPublicationStatus(storage, "", shielded), true);
  assert.equal(cachedPublicationStatus(storage, "0xeeee", shielded), false);
  assert.equal(cachedPublicationStatus(storage, "0xabcd", { ...shielded, B: [1n, 2n] }), false);
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

// An unpublished address is not a working handle: `resolveRecipient` reads the
// registry, so a sender given this address before publication looks up nothing.
// The card must offer publication in that slot, not the dead address.
test("withholds the address until it resolves, offering publication instead", () => {
  const unpublished = renderVaultIdentityControls({ shielded, account: "0x1234", registered: false, busy: false });

  assert.doesNotMatch(unpublished, /<code class="holder-address">/);
  assert.doesNotMatch(unpublished, /data-copy-label="Address"/);
  assert.match(unpublished, /<button id="register-keys"[^>]*class="holder-publish ?[^"]*"/);
});

// The two waits are different instructions to the user: go press a button in
// your wallet, versus sit still while the chain confirms. Collapsing them into
// one spinner loses the only actionable half.
test("names each publication wait, then confirms the address resolves", () => {
  const signing = renderVaultIdentityControls({ shielded, account: "0x1234", registered: false, busy: true, publishPhase: "signing" });
  const confirming = renderVaultIdentityControls({ shielded, account: "0x1234", registered: false, busy: true, publishPhase: "confirming" });
  const done = renderVaultIdentityControls({ shielded, account: "0x1234", registered: true, busy: false, publishPhase: "published" });

  assert.match(signing, /class="spinner"[^>]*><\/span>CONFIRM IN YOUR WALLET/);
  assert.match(confirming, /class="spinner"[^>]*><\/span>PUBLISHING ON L1/);
  // Progress keeps the solid fill; the dashed disabled treatment reads as broken.
  assert.match(signing, /class="holder-publish is-working"/);
  assert.match(done, /✓ PUBLISHED/);
  assert.match(done, /<code class="holder-address">0x1234<\/code>/);
  assert.doesNotMatch(done, /id="register-keys"/);
});

// `cachedPublicationStatus` reports true for a known fingerprint even with no
// wallet connected, so `registered` alone does not mean there is an address to
// show. Gating on it alone rendered an empty chip beside a PUBLISHED badge.
test("never renders an empty address chip when no wallet is connected", () => {
  const html = renderVaultIdentityControls({ shielded, account: "", registered: true, busy: false });

  assert.doesNotMatch(html, /<code class="holder-address">\s*<\/code>/);
  assert.doesNotMatch(html, /<code class="holder-address">/);
  assert.match(html, /No wallet connected — connect one to see your address/);
  assert.match(html, /data-connect-wallet/);
  assert.doesNotMatch(html, /PUBLISHED/);
});

test("disables an unpublished address action while another operation is busy", () => {
  const html = renderVaultIdentityControls({ shielded, account: "0x1234", registered: false, busy: true });
  assert.match(html, /id="register-keys"[^>]*disabled/);
});

test("renders the credential card as a ticket stub with an identicon fingerprint", () => {
  const html = renderVaultIdentityControls({ shielded, account: "0x1234", registered: true, busy: false });

  assert.match(html, /<svg class="identicon"/);
  assert.match(html, /FINGERPRINT/);
  assert.match(html, /check this matches/i);
  // Never word the fingerprint as authentication — it is a change detector only.
  assert.doesNotMatch(html, /\bverifies\b|\bconfirms\b|\bproves\b|\bauthenticated\b/i);
});

// With the key rows gone, the footer is the only place the curve is stated.
// It has to stay: the card must never read as a secp256k1 stealth address.
test("names the curve on the card, never secp256k1", () => {
  const html = renderVaultIdentityControls({ shielded, account: "0x1234", registered: true, busy: false });

  assert.match(html, /BABY JUBJUB · POSEIDON/);
  assert.doesNotMatch(html, /secp256k1/i);
});

test("offers the L1 address as the handle, not a meta-address blob", () => {
  const html = renderVaultIdentityControls({ shielded, account: "0x1234", registered: true, busy: false });

  // `resolveRecipient` looks recipients up BY ADDRESS, so the address is the only
  // handle a sender can act on. A displayed meta-address is a string the app
  // cannot consume and that only ERC-5564 tooling would misparse.
  assert.match(html, /data-copy-shielded="0x1234" data-copy-label="Address"/);
  assert.match(html, />COPY ADDRESS</);
  assert.doesNotMatch(html, /SHIELDED META-ADDRESS/);
  assert.doesNotMatch(html, /st:eth:/);
  assert.doesNotMatch(html, /cutout:eth:/);
  // The 64-hex-limb rendering is what made the blob unreadable; it must not return.
  assert.doesNotMatch(html, /[0-9a-f]{64}/);
});

test("cannot offer to copy an address before a wallet is connected", () => {
  const html = renderVaultIdentityControls({ shielded, account: "", registered: null, busy: false });
  assert.match(html, /<button[^>]*copy-meta-address[^>]*disabled[^>]*>COPY ADDRESS</);
  assert.doesNotMatch(html, /data-copy-label="Address"/);
  // The empty slot says what to do about it rather than rendering a bare dash.
  assert.match(html, /holder-row is-empty/);
  assert.match(html, /No wallet connected — connect one to see your address/);
});

test("labels the domain-separated scheme, never a bare ERC-5564 scheme index", () => {
  const html = renderVaultIdentityControls({ shielded, account: "0x1234", registered: true, busy: false });

  assert.match(html, /SCHEME · CUTOUT-BJJ/);
  assert.doesNotMatch(html, /SCHEME #1/i);
});

// The badge may claim ERC-6538 (the registry this app really does write to and
// read from). It must never claim ERC-5564: these are Baby Jubjub keys, and a
// conformant stealth wallet reading them as secp256k1 derives a garbage
// address (CLAUDE.md §2).
test("badges the registry only, never ERC-5564 conformance", () => {
  const html = renderVaultIdentityControls({ shielded, account: "0x1234", registered: true, busy: false });

  assert.match(html, /ERC-6538 COMPLIANT/);
  assert.doesNotMatch(html, /ERC-5564/i);
});

test("integrates identity controls through homeView rather than the shared app shell", async () => {
  const source = await readFile(new URL("./main.js", import.meta.url), "utf8");
  const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
  const appShellSource = section("function appShell()", "function bind()");
  const homeViewSource = section("function homeView()", "function noteMapDestination(");

  assert.doesNotMatch(appShellSource, /renderVaultIdentityControls|vaultAddressTile/);
  assert.match(homeViewSource, /renderVaultIdentityControls/);
});

test("wires the identicon into the topbar (loaded-vault check) and the send panel (resolved-recipient check)", async () => {
  const source = await readFile(new URL("./main.js", import.meta.url), "utf8");
  const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
  const topbarSource = section("function topbar()", "function footer()");
  const sendViewSource = section("function sendView()", "function receiveView()");

  const fingerprintSource = section("function sendFingerprint(", "function sendView(");

  assert.match(source, /import \{ renderIdenticon \} from "\.\/identicon\.js"/);
  // Topbar only shows the mark once an identity is actually loaded.
  assert.match(topbarSource, /state\.identity \?/);
  assert.match(topbarSource, /renderIdenticon\(state\.identity\.shielded/);
  assert.match(sendViewSource, /sendFingerprint\(send, recipientMode\)/);
  assert.match(fingerprintSource, /renderIdenticon\(send\.resolved/);
});

test("shows a recipient mark only for a looked-up user, on the right edge of the address field", async () => {
  const source = await readFile(new URL("./main.js", import.meta.url), "utf8");
  const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
  const fingerprintSource = section("function sendFingerprint(", "function sendView(");
  const sendViewSource = section("function sendView()", "function receiveView()");

  // A self-bridge gets no mark: the vault's own fingerprint is already in the
  // topbar, so a second copy asks the user to compare it against itself.
  assert.match(fingerprintSource, /recipientMode !== "other"/);
  assert.doesNotMatch(fingerprintSource, /state\.identity/);
  // The mark lives inside the recipient address field, not as a standalone card.
  assert.match(sendViewSource, /<div class="input-with-mark">[\s\S]*id="send-recipient"[\s\S]*sendFingerprint\(send, recipientMode\)[\s\S]*<\/div>/);
});
