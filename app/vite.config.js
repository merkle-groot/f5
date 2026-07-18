import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      assert: fileURLToPath(new URL("./src/assert-shim.js", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:8787",
    },
    /**
     * Hosts allowed in addition to Vite's defaults (localhost + any bare IP).
     *
     * Testing on a phone needs HTTPS, not just `--host`: the Vault encrypts the recovery phrase
     * with `crypto.subtle`, and WebCrypto only exists in a SECURE CONTEXT. Over
     * `http://<lan-ip>:5173` `crypto.subtle` is undefined, so the Vault cannot even be created or
     * unlocked. `localhost` is exempt; a LAN IP is not. So tunnel instead:
     *
     *   cloudflared tunnel --url http://localhost:5173
     *
     * Only port 5173 needs tunnelling — the `/api` proxy above runs server-side, so the API (8787)
     * and the relayer (8788) stay local.
     *
     * Vite rejects unknown Host headers, which would otherwise 403 the tunnel domain. Add another
     * host with VITE_ALLOWED_HOSTS=a.example,b.example.
     */
    allowedHosts: [
      ".trycloudflare.com",
      ...(process.env.VITE_ALLOWED_HOSTS?.split(",").map((h) => h.trim()).filter(Boolean) ?? []),
    ],
  },
});
