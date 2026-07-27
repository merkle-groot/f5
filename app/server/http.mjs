/**
 * Serialize a payload containing bigints.
 *
 * Indexer events are full of them (commitments, labels, nullifiers), and
 * `JSON.stringify` THROWS on a bigint rather than coercing it. Handlers that spread
 * an event straight into `res.json` therefore blew up inside their own try-block and
 * returned a 502 — which is why `/api/activity` never worked.
 */
export function sendJson(res, payload, status = 200) {
  return res
    .status(status)
    .type("application/json")
    .send(
      JSON.stringify(payload, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    );
}

/** The message from an unknown thrown value, for error responses. */
export const errorMessage = (error, fallback) =>
  error instanceof Error ? error.message : fallback;

/**
 * Parse a `:commitment` route param, or throw a 400-shaped error.
 *
 * `BigInt("nonsense")` throws a SyntaxError, and every route that read a commitment
 * did so inside a try-block whose catch answered 502 "unable to read L2 status" —
 * blaming the chain for a malformed request and sending the caller to look at the
 * RPC. The `status` property is what `handler` and the route catches use to pick the
 * response code.
 */
export function parseCommitment(value, field = "commitment") {
  const reject = () => {
    const error = new Error(`Invalid ${field} "${value}": expected a decimal or 0x integer`);
    error.status = 400;
    throw error;
  };
  // `BigInt("")` and `BigInt("   ")` are 0n, not a throw. Left to itself a blank
  // param would be read as a query about commitment zero and answered confidently.
  if (typeof value === "string" && value.trim() === "") reject();
  try {
    return BigInt(value);
  } catch {
    return reject();
  }
}

/**
 * Wrap an async handler so a throw becomes a JSON error response rather than an
 * unhandled rejection Express reports as a bare 500 with an HTML body.
 */
export function handler(fn, { status = 502, fallback = "Request failed" } = {}) {
  return async (req, res) => {
    try {
      return await fn(req, res);
    } catch (error) {
      if (res.headersSent) return undefined;
      return sendJson(res, { error: errorMessage(error, fallback) }, error.status ?? status);
    }
  };
}
