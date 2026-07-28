/**
 * End-to-end HTTP tests for the load-shedding wiring.
 *
 * Unlike `throttle.spec.ts` (which unit-tests the middleware over mock req/res), this
 * boots the REAL Express `app` and fires REAL concurrent requests over a loopback
 * socket. It therefore proves the parts the unit tests cannot:
 *
 *  - the in-flight gate is actually mounted, first, on `POST /relayer/request`
 *    (`routes/index.ts`) and returns 503 over the wire when saturated;
 *  - the per-IP rate limit is actually mounted on the `/relayer` router and 429s;
 *  - `app.ts`'s `RELAYER_TRUST_PROXY` parsing makes `req.ip` honour X-Forwarded-For,
 *    so callers are limited individually rather than sharing one bucket.
 *
 * Only the leaves are mocked — the request handler (so a request can be held
 * in-flight), the body validators (so any body reaches the handler), and the config
 * barrel (so no chain/provider graph is constructed on import). The routing, throttle
 * middleware, and trust-proxy logic under test are all the real modules.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// Must be set before the dynamic import of `app` below (module-scope reads).
process.env.RELAYER_MAX_INFLIGHT_RELAYS = "2";
process.env.RELAYER_RATE_LIMIT_MAX = "3";
process.env.RELAYER_RATE_LIMIT_WINDOW_MS = "60000";
process.env.RELAYER_TRUST_PROXY = "true";

// Requests that reach the (mocked) relay handler park here until released, so we can
// hold slots open and observe the gate saturate.
const h = vi.hoisted(() => ({ pending: [] as Array<() => void> }));

const ok = (_req: unknown, res: { status(c: number): { json(b: unknown): void } }) => {
  res.status(200).json({ ok: true });
};

vi.mock("../../src/config/index.js", () => ({
  CORS_ALLOW_ALL: true,
  ALLOWED_DOMAINS: [] as string[],
}));

vi.mock("../../src/middlewares/relayer/request.js", () => ({
  validateDetailsMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  validateQuoteMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  validateRelayRequestMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../src/handlers/index.js", () => ({
  // Blocks until released, so the request holds an in-flight slot.
  relayRequestHandler: (_req: unknown, res: { status(c: number): { json(b: unknown): void } }) =>
    new Promise<void>((resolve) => {
      h.pending.push(() => {
        res.status(200).json({ ok: true });
        resolve();
      });
    }),
  relayerDetailsHandler: ok,
  relayQuoteHandler: ok,
  testnetAspProofHandler: async (_req: unknown, res: { status(c: number): { json(b: unknown): void } }) => ok(_req, res),
  listDestinationsHandler: ok,
  destinationDetailsHandler: ok,
  destinationActivateHandler: ok,
  destinationWithdrawHandler: ok,
}));

let server: Server;
let baseUrl: string;

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** POST /relayer/request with a spoofed client IP via X-Forwarded-For. */
function postRequest(ip: string): Promise<Response> {
  return fetch(`${baseUrl}/relayer/request`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
    body: "{}",
  });
}

function getDetails(ip: string): Promise<Response> {
  return fetch(`${baseUrl}/relayer/details`, {
    headers: { "X-Forwarded-For": ip },
  });
}

describe("HTTP load shedding (real app, real routing)", () => {
  beforeAll(async () => {
    const { app } = await import("../../src/app.js");
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    // Release anything still parked, then close.
    h.pending.splice(0).forEach((r) => r());
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("503s a POST /relayer/request once the in-flight cap (2) is saturated", async () => {
    // Two requests, distinct IPs so the per-IP rate limit never interferes; they park
    // in the handler and hold both slots.
    const p1 = postRequest("10.0.0.1");
    const p2 = postRequest("10.0.0.2");
    await waitFor(() => h.pending.length === 2);

    // A third, again a distinct IP: the only thing that can reject it is the gate.
    const r3 = await postRequest("10.0.0.3");
    expect(r3.status).toBe(503);
    expect(r3.headers.get("retry-after")).toBe("1");

    // Release the two held requests; the freed slots let a fourth through.
    h.pending.splice(0).forEach((r) => r());
    const [a, b] = await Promise.all([p1, p2]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    await waitFor(() => h.pending.length === 0);
    // Sanity: with slots free again, a fresh request is admitted (parks, then release).
    const p4 = postRequest("10.0.0.4");
    await waitFor(() => h.pending.length === 1);
    h.pending.splice(0).forEach((r) => r());
    expect((await p4).status).toBe(200);
  });

  it("429s a single IP past the per-IP window max (3), on the router level", async () => {
    // /details is instant (mocked), so this isolates the rate limit from the gate.
    const ip = "7.7.7.7";
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await getDetails(ip)).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it("honours X-Forwarded-For (trust proxy on): distinct IPs get independent budgets", async () => {
    // Five requests, each a distinct spoofed IP: with trust-proxy honouring XFF every
    // one is a fresh bucket, so none is limited despite max being 3. If XFF were
    // ignored they'd share the loopback IP and the 4th would 429 — so this asserts
    // both the per-IP keying and app.ts's RELAYER_TRUST_PROXY parsing.
    const statuses = await Promise.all(
      ["8.0.0.1", "8.0.0.2", "8.0.0.3", "8.0.0.4", "8.0.0.5"].map(async (ip) =>
        (await getDetails(ip)).status,
      ),
    );
    expect(statuses).toEqual([200, 200, 200, 200, 200]);
  });
});
