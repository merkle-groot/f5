import { NextFunction, Request, Response } from "express";

/**
 * Load-shedding middleware for the relayer's public endpoints.
 *
 * The relayer is being opened up to arbitrary callers, so the process must protect
 * itself from a request burst. Two independent concerns, two guards:
 *
 *  - `inFlightLimit` bounds how many requests are processed at once. The relay path
 *    runs a Groth16 verification (CPU-bound, blocks the event loop) before it ever
 *    touches a signer; without a ceiling a burst starves everything, including
 *    `/ping`. Past the ceiling we shed load immediately with 503 rather than queue
 *    unboundedly and fall over later.
 *  - `rateLimitPerIp` bounds how often a single caller can hit us in a window, so one
 *    client cannot monopolise those in-flight slots.
 *
 * Both are per-process, in-memory, and deliberately dependency-free — matching how the
 * rest of this package hand-rolls its limiters (`KeyedConcurrencyLimiter`,
 * `KeyedSerialExecutor`). Behind multiple instances, tune the limits per instance.
 */

/**
 * Cap concurrent in-flight requests through this middleware. Shared counter across
 * every request that passes through the returned handler, so instantiate it ONCE.
 *
 * @param {number} max - Maximum requests processed simultaneously.
 * @returns Express middleware.
 */
export function inFlightLimit(max: number) {
  let inFlight = 0;
  return function inFlightLimiter(_req: Request, res: Response, next: NextFunction) {
    if (inFlight >= max) {
      res.setHeader("Retry-After", "1");
      res.status(503).json({ error: "Relayer busy, please retry shortly." });
      return;
    }
    inFlight++;
    // `finish` and `close` can both fire; release exactly once either way.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inFlight--;
    };
    res.on("finish", release);
    res.on("close", release);
    next();
  };
}

/**
 * Fixed-window per-IP rate limit. Instantiate ONCE so the window state is shared.
 *
 * @param {number} windowMs - Window length in milliseconds.
 * @param {number} max - Maximum requests per IP per window.
 * @returns Express middleware.
 */
export function rateLimitPerIp(windowMs: number, max: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  // Opportunistic sweep of expired windows so the map cannot grow without bound under
  // a churn of distinct IPs. Cheap, and only when the map is already large.
  const sweep = (now: number) => {
    if (hits.size < 10_000) return;
    for (const [key, entry] of hits) {
      if (now >= entry.resetAt) hits.delete(key);
    }
  };

  return function ipRateLimiter(req: Request, res: Response, next: NextFunction) {
    const now = Date.now();
    const key = req.ip ?? "unknown";
    const entry = hits.get(key);

    if (!entry || now >= entry.resetAt) {
      sweep(now);
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    if (entry.count >= max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: "Too many requests, please slow down." });
      return;
    }

    entry.count++;
    next();
  };
}
