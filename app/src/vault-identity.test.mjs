import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("integrates identity controls through homeView rather than the shared app shell", async () => {
  const source = await readFile(new URL("./main.js", import.meta.url), "utf8");
  const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
  const appShellSource = section("function appShell()", "function bind()");
  const homeViewSource = section("function homeView()", "function noteMapDestination(");

  assert.doesNotMatch(appShellSource, /renderVaultIdentityControls|vaultAddressTile/);
  assert.match(homeViewSource, /renderVaultIdentityControls/);
});
