/**
 * Block-explorer links.
 *
 * Split out of `main.js` because both halves are security-relevant and neither is
 * reachable from a test otherwise: the origin comes from deployment config and the
 * hash from a relayer response, and both end up inside an `href`. A remote field
 * must never reach an anchor untested, so the shape checks below are the whole
 * point of this module rather than incidental validation.
 */

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

/**
 * A `/tx/<hash>` URL under `base`, or "" when either half is unusable.
 *
 * The scheme test is what stops a mis-set `EXPLORER_URL` (`javascript:…`) from
 * becoming a live link. Both EVM explorers and the Starknet ones (Voyager,
 * Starkscan) use the same `/tx/` path, so one shape covers every route.
 *
 * 64 hex digits is the ceiling, not a round number: an EVM transaction hash is
 * exactly 32 bytes, and a Starknet one is a felt252 written unpadded, so it is
 * never longer. Anything above that is malformed and must not be linked.
 */
export function explorerTxUrl(base, hash) {
  const origin = String(base ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(origin)) return "";
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(String(hash ?? ""))) return "";
  return `${origin}/tx/${hash}`;
}

/**
 * An explorer anchor, or "" when the transaction cannot be linked.
 *
 * Links are strictly additive: a deployment that configured no explorer renders
 * nothing rather than a dead link.
 */
export function txLinkHtml(base, hash, label = "VIEW ON EXPLORER") {
  const url = explorerTxUrl(base, hash);
  if (!url) return "";
  return `<a class="tx-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)} ↗</a>`;
}
