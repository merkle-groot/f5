import { defineConfig } from "vite";
import { brotliCompress, constants as zlibConstants } from "node:zlib";
import { promisify } from "node:util";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

const compressBrotli = promisify(brotliCompress);
const compressible = /\.(?:css|html|js|json|mjs|svg)$/;

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesIn(path) : [path];
  }))).flat();
}

/** Emit static Brotli siblings for Caddy's `file_server precompressed br` support. */
function precompressBuild() {
  return {
    name: "precompress-build",
    apply: "build",
    async closeBundle() {
      const outputDirectory = fileURLToPath(new URL("./dist", import.meta.url));
      const files = await filesIn(outputDirectory);
      await Promise.all(files.filter((file) => compressible.test(file)).map(async (file) => {
        const source = await readFile(file);
        const compressed = await compressBrotli(source, {
          params: { [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY },
        });
        await writeFile(`${file}.br`, compressed);
      }));
    },
  };
}

export default defineConfig({
  plugins: [precompressBuild()],
  resolve: {
    alias: {
      assert: fileURLToPath(new URL("./src/assert-shim.js", import.meta.url)),
    },
  },
  /**
   * The proving worker (src/prover.worker.js) dynamically imports the SDK, which
   * code-splits. Vite's default worker format is `iife`, and an IIFE bundle cannot
   * be split — the build fails outright rather than degrading. ES workers are
   * supported everywhere `import.meta.url` workers are, and `prove.js` falls back
   * to main-thread proving on browsers where the worker will not start at all.
   */
  worker: {
    format: "es",
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
