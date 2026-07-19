/**
 * Proxy write requests to the relayer.
 *
 * The app server holds no private keys and signs nothing. Every transaction —
 * L1 relay, L2 activation, L2 withdrawal, on every chain family — is constructed
 * and signed by the relayer; this module is the whole of the app server's
 * involvement in a write.
 *
 * Deliberately dumb: no payload rewriting. The relayer accepts the request shapes
 * the browser already sends, so there is no translation layer here to drift out of
 * sync with either side.
 */

/** Strip any trailing slash so `${base}${path}` never double-slashes. */
function relayerBase() {
  const url = process.env.RELAYER_API_URL;
  return url ? url.replace(/\/$/, "") : null;
}

/**
 * Forward a JSON request to the relayer and mirror its response.
 *
 * Status codes pass through untouched — the relayer distinguishes 404 (unknown
 * destination) from 503 (destination has no signer) from 502 (the write failed),
 * and collapsing those would hide the difference from the UI.
 *
 * @param {(req: import("express").Request) => string} pathFor - Relayer path builder.
 * @param {{ method?: string, unavailable?: string, onSuccess?: () => void }} [options]
 *   `onSuccess` fires when the relayer accepted the request. It must not throw or
 *   block: it is a side channel for local bookkeeping, never part of the response.
 */
export function proxyToRelayer(
  pathFor,
  { method = "POST", unavailable = "Relayer unavailable", onSuccess } = {},
) {
  return async (req, res) => {
    const base = relayerBase();
    if (!base) {
      return res.status(503).json({ error: "RELAYER_API_URL is not configured" });
    }

    try {
      const response = await fetch(`${base}${pathFor(req)}`, {
        method,
        headers: { "content-type": "application/json" },
        // A GET with a body is malformed and some servers reject it outright.
        body: method === "GET" ? undefined : JSON.stringify(req.body ?? {}),
      });

      const text = await response.text();

      if (response.ok && onSuccess) {
        // Never let a bookkeeping failure turn an accepted relay into an error
        // response — the transaction is already on its way.
        try {
          onSuccess();
        } catch (error) {
          console.warn("[relayer-proxy] onSuccess hook failed:", error);
        }
      }

      // Forward the relayer's own body verbatim when it is JSON. Re-encoding via
      // `res.json(await response.json())` would throw on an empty or non-JSON error
      // body and turn the relayer's precise status into an opaque 502.
      res.status(response.status).type("application/json");
      return res.send(text || JSON.stringify({ error: unavailable }));
    } catch (error) {
      // The relayer is unreachable — distinct from the relayer refusing the write.
      return res.status(502).json({ error: error instanceof Error ? error.message : unavailable });
    }
  };
}

/**
 * POST to the relayer from server-side code (the activation scanner), rather than on
 * behalf of a browser request.
 *
 * Throws on refusal instead of mirroring a status, because the caller is a loop that
 * needs to log and move on, not an HTTP handler with a response to shape.
 *
 * @param {string} path - Relayer path.
 * @param {unknown} body - JSON body.
 */
export async function postToRelayer(path, body) {
  const base = relayerBase();
  if (!base) throw new Error("RELAYER_API_URL is not configured");

  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Relayer responded ${response.status} with a non-JSON body`);
  }

  // The relayer reports a refused write as `success: false` with a 502, and a
  // malformed one as a 4xx with `message`. Both are failures to the caller.
  if (!response.ok || parsed.success === false) {
    throw new Error(parsed.error ?? parsed.message ?? `Relayer responded ${response.status}`);
  }
  return parsed;
}

/**
 * Read a relayer endpoint and return its parsed JSON.
 *
 * Used by the config endpoints, which merge the relayer's signer state into their
 * own response rather than proxying it wholesale.
 *
 * @param {string} path - Relayer path, e.g. `/relayer/destinations/op`.
 */
export async function fetchFromRelayer(path) {
  const base = relayerBase();
  if (!base) throw new Error("RELAYER_API_URL is not configured");

  const response = await fetch(`${base}${path}`);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.message ?? body?.error ?? `Relayer responded ${response.status}`);
  }
  return body;
}
