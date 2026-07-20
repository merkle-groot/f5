function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

function short(value) {
  const text = String(value);
  return text.length > 16 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
}

const PUBLISHED_ADDRESSES_KEY = "f5-published-addresses-v1";

function identityFingerprint(shielded) {
  const { B, V } = shielded;
  return `${B[0]},${B[1]}:${V[0]},${V[1]}`;
}

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

export function renderVaultIdentityControls({ shielded, account, registered, busy }) {
  const { B, V } = shielded;
  const status = registered === true ? "PUBLISHED" : !account ? "CONNECT WALLET" : registered === false ? "NOT PUBLISHED" : "CHECKING";
  const statusControl = !account && registered !== true
    ? `<button type="button" class="online identity-connect" data-connect-wallet><i class="dot teal-dot"></i> ${status}</button>`
    : `<span class="online"><i class="dot teal-dot"></i> ${status}</span>`;
  const spendingKey = `${B[0]}, ${B[1]}`;
  const viewingKey = `${V[0]}, ${V[1]}`;
  const publishAction = registered === false
    ? `<button id="register-keys" class="secondary-btn" ${busy ? "disabled" : ""}>PUBLISH SHIELDED ADDRESS</button>`
    : "";
  const identityNote = registered === true
    ? "Your shielded address is published. Senders can resolve this wallet and deliver shielded notes directly to your vault. Your private keys and recovery phrase stay local."
    : "Publish your public shielded keys so senders can resolve your connected wallet and deliver shielded notes to this vault. Your private keys and recovery phrase stay local and are never published.";

  return `
    <section class="transit-identity" aria-labelledby="shielded-address-title">
      <div class="card-heading"><h2 id="shielded-address-title">SHIELDED ADDRESS</h2>${statusControl}</div>
      <p class="identity-copy identity-note">${identityNote}</p>
      <div class="shielded-key-list">
        <div class="shielded-key-row"><span>SPENDING KEY</span><code>${short(B[0])} · ${short(B[1])}</code><button type="button" data-copy-shielded="${escapeHtml(spendingKey)}" data-copy-label="Spending key">COPY</button></div>
        <div class="shielded-key-row"><span>VIEWING KEY</span><code>${short(V[0])} · ${short(V[1])}</code><button type="button" data-copy-shielded="${escapeHtml(viewingKey)}" data-copy-label="Viewing key">COPY</button></div>
      </div>
      <div class="transit-identity-actions">${publishAction}<button id="reveal-mnemonic" class="secondary-btn">SHOW RECOVERY PHRASE</button></div>
    </section>`;
}
