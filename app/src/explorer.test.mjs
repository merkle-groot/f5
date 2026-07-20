import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { explorerTxUrl, txLinkHtml } from "./explorer.js";

const HASH = "0xabc123def4567890abc123def4567890abc123def4567890abc123def4567890";

describe("explorerTxUrl", () => {
  it("joins an explorer origin with the transaction path", () => {
    assert.equal(explorerTxUrl("https://sepolia.etherscan.io", HASH), `https://sepolia.etherscan.io/tx/${HASH}`);
  });

  it("tolerates a trailing slash and surrounding whitespace in the configured origin", () => {
    assert.equal(explorerTxUrl("  https://sepolia.voyager.online//  ", HASH), `https://sepolia.voyager.online/tx/${HASH}`);
  });

  it("returns nothing when no explorer is configured", () => {
    for (const base of ["", "   ", null, undefined]) {
      assert.equal(explorerTxUrl(base, HASH), "", `expected no link for ${JSON.stringify(base)}`);
    }
  });

  // A mis-set EXPLORER_URL must not become a live link — this is the check that
  // keeps a non-http origin out of the rendered href entirely.
  it("refuses an origin that is not http(s)", () => {
    for (const base of ["javascript:alert(1)", "data:text/html,x", "//evil.example", "ftp://x.example"]) {
      assert.equal(explorerTxUrl(base, HASH), "", `expected no link for ${base}`);
    }
  });

  // The hash arrives from a relayer response, so it is untrusted input.
  it("refuses a hash that is not plain 0x hex", () => {
    const bad = ["", "abc", "0x", "0xzz", `${HASH}0`, '0xdead" onmouseover="x', "0xdead#/../evil"];
    for (const hash of bad) {
      assert.equal(explorerTxUrl("https://sepolia.etherscan.io", hash), "", `expected no link for ${JSON.stringify(hash)}`);
    }
  });
});

describe("txLinkHtml", () => {
  it("renders an anchor that cannot leak the opener", () => {
    const html = txLinkHtml("https://sepolia.etherscan.io", HASH);
    assert.match(html, /rel="noopener noreferrer"/);
    assert.match(html, /target="_blank"/);
    assert.match(html, new RegExp(`href="https://sepolia\\.etherscan\\.io/tx/${HASH}"`));
  });

  it("uses the caller's label", () => {
    assert.match(txLinkHtml("https://sepolia.etherscan.io", HASH, "VIEW L1 RELAY"), />VIEW L1 RELAY ↗</);
  });

  it("escapes a label rather than trusting it as markup", () => {
    const html = txLinkHtml("https://sepolia.etherscan.io", HASH, '<img src=x onerror=alert(1)>');
    assert.ok(!html.includes("<img"), "label must not render as markup");
    assert.match(html, /&lt;img/);
  });

  it("renders nothing at all when the transaction cannot be linked", () => {
    assert.equal(txLinkHtml("", HASH), "");
    assert.equal(txLinkHtml("https://sepolia.etherscan.io", "not-a-hash"), "");
  });
});
