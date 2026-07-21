import { renderIdenticon } from "./identicon.js";

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

const PUBLISHED_ADDRESSES_KEY = "f5-published-addresses-v1";

function identityFingerprint(shielded) {
  const { B, V } = shielded;
  return `${B[0]},${B[1]}:${V[0]},${V[1]}`;
}

/**
 * The interchange string printed on the credential card and handed to the
 * COPY META-ADDRESS button. `cutout:eth:` — never the ERC-5564 `st:eth:`
 * prefix, which would invite a conformant stealth wallet to parse this
 * Baby Jubjub blob as secp256k1 and send real funds to a garbage address.
 * Four 32-byte big-endian limbs: B.x, B.y, V.x, V.y.
 */
/*
 * There is deliberately no meta-address handle on this card.
 *
 * `resolveRecipient` in main.js takes an L1 ADDRESS and reads the keys back out
 * of the ERC-6538 registry — nothing in this app ever parses a pasted
 * meta-address. Printing 256 hex characters gave the user a handle they could
 * not actually hand to a sender, and inviting them to copy it around is worse
 * than useless: the only tooling that would accept a string of that shape is a
 * conformant ERC-5564 wallet, which would read these Baby Jubjub limbs as
 * secp256k1 and derive a garbage address. The address below is the handle.
 *
 * The raw B and V limbs are not printed either. They are derived from the
 * recovery phrase and resolved from the registry by senders; a user who reads
 * them off this card has nothing to do with them.
 */

export function cachedPublicationStatus(storage, account, shielded) {
  if (!storage || !shielded) return false;
  try {
    const published = JSON.parse(storage.getItem(PUBLISHED_ADDRESSES_KEY) ?? "{}");
    const fingerprint = identityFingerprint(shielded);
    return account
      ? published[account.toLowerCase()] === fingerprint
      : Object.values(published).includes(fingerprint);
  } catch {
    return false;
  }
}

export function storePublicationStatus(storage, account, shielded, published) {
  if (!storage || !account || !shielded) return;
  try {
    const values = JSON.parse(storage.getItem(PUBLISHED_ADDRESSES_KEY) ?? "{}");
    const key = account.toLowerCase();
    if (published) values[key] = identityFingerprint(shielded);
    else delete values[key];
    storage.setItem(PUBLISHED_ADDRESSES_KEY, JSON.stringify(values));
  } catch { /* localStorage can be unavailable in hardened browser modes */ }
}

/**
 * What the publish button says while it works.
 *
 * The two waits are told apart on purpose: "signing" is waiting on the user and
 * they have to go look at their wallet, "confirming" is waiting on the chain and
 * they should sit still. A single spinner would flatten them into one shrug.
 */
function publishLabel(phase) {
  if (phase === "signing") return `<span class="spinner" aria-hidden="true"></span>CONFIRM IN YOUR WALLET…`;
  if (phase === "confirming") return `<span class="spinner" aria-hidden="true"></span>PUBLISHING ON L1…`;
  return "PUBLISH SHIELDED ADDRESS";
}

/**
 * The shielded-address panel, styled as a ticket-stub credential card: a
 * perforated left stub carrying the identicon fingerprint, and the address the
 * user hands out — or the action that makes it resolvable — on the right.
 */
export function renderVaultIdentityControls({ shielded, account, registered, busy, publishPhase = null }) {
  // Publication is per wallet, so with none connected the badge asks for one
  // rather than reporting a cached fingerprint as this wallet's status.
  const status = !account ? "CONNECT WALLET" : registered === true ? "PUBLISHED" : registered === false ? "NOT PUBLISHED" : "CHECKING";
  const statusControl = !account
    ? `<button type="button" class="online identity-connect" data-connect-wallet><i class="dot teal-dot"></i> ${status}</button>`
    : `<span class="online"><i class="dot teal-dot"></i> ${status}</span>`;
  const holder = escapeHtml(account);
  /*
   * The address slot follows what a sender could actually do with it.
   *
   * Until the keys are in the registry, `resolveRecipient` finds nothing at
   * this address — handing it out would send people to a lookup that fails.
   * So the unpublished card offers the fix in that spot instead of a handle
   * that does not work yet.
   *
   * The address branch also requires a connected account, not just
   * `registered`: `cachedPublicationStatus` answers true for a known-published
   * fingerprint with no wallet connected, which rendered an empty <code> chip
   * beside a PUBLISHED badge — the card claiming to show an address it did not
   * have.
   */
  const holderSlot = registered === true && account
    ? `${publishPhase === "published" ? `<p class="publish-done"><b>✓ PUBLISHED</b> Your address resolves now — people can send to it.</p>` : ""}
      <div class="holder-row${publishPhase === "published" ? " just-published" : ""}">
        <code class="holder-address">${holder}</code>
        <button type="button" class="copy-meta-address" data-copy-shielded="${escapeHtml(account)}" data-copy-label="Address">COPY ADDRESS</button>
      </div>`
    : registered === false && account
      ? `<button id="register-keys" type="button" class="holder-publish ${publishPhase ? "is-working" : ""}" ${busy ? "disabled" : ""}>${publishLabel(publishPhase)}</button>`
      : `<div class="holder-row is-empty">
        <span class="holder-address holder-empty">${account ? "Checking the registry…" : "No wallet connected — connect one to see your address"}</span>
        <button type="button" class="copy-meta-address" disabled>COPY ADDRESS</button>
      </div>`;
  const holderLine = registered === true && account
    ? "Give people this address. They look you up with it, and the notes they send arrive in this vault."
    : registered === false && account
      ? "Publish once, and this address becomes the handle people send to. It costs one L1 transaction and reveals only your public keys."
      : "Once a wallet is connected and published, its address becomes the handle people send to.";
  const identityNote = registered === true
    ? "Your shielded address is published. Senders can resolve this wallet and deliver shielded notes directly to your vault. Your private keys and recovery phrase stay local."
    : "Publish your public shielded keys so senders can resolve your connected wallet and deliver shielded notes to this vault. Your private keys and recovery phrase stay local and are never published.";

  return `
    <section class="transit-identity credential-card" aria-labelledby="shielded-address-title">
      <div class="card-heading credential-heading">
        <h2 id="shielded-address-title">SHIELDED ADDRESS</h2>
        <span class="registry-badge">ERC-6538 COMPLIANT</span>
        ${statusControl}
      </div>
      <p class="identity-copy identity-note">${identityNote}</p>
      <div class="credential-body">
        <div class="credential-stub">
          <span class="eyebrow">FINGERPRINT</span>
          <span class="stub-identicon">${renderIdenticon(shielded, { px: 76, label: "Your shielded address fingerprint" })}</span>
          <p class="fingerprint-caption">check this matches on the recipient's device</p>
        </div>
        <div class="credential-perforation" aria-hidden="true"></div>
        <div class="credential-details">
          <div class="credential-field">
            <p class="holder-line">${holderLine}</p>
            ${holderSlot}
          </div>
        </div>
      </div>
      <div class="transit-identity-actions"><button id="reveal-mnemonic" class="secondary-btn">SHOW RECOVERY PHRASE</button></div>
      <div class="credential-footer">
        <span>REGISTRY · 0x6538…6538</span>
        <span>SCHEME · CUTOUT-BJJ</span>
        <span>BABY JUBJUB · POSEIDON</span>
      </div>
    </section>`;
}
