import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { fetchFromRelayer, proxyToRelayer } from "./relayer-proxy.mjs";

/** Minimal express `res` double recording what the handler produced. */
function fakeRes() {
  const res = {
    statusCode: null,
    contentType: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    type(value) { this.contentType = value; return this; },
    json(payload) { this.body = payload; return this; },
    send(payload) { this.body = payload; return this; },
  };
  return res;
}

const originalFetch = globalThis.fetch;
const originalUrl = process.env.RELAYER_API_URL;

beforeEach(() => {
  process.env.RELAYER_API_URL = "http://relayer:8788";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.RELAYER_API_URL;
  else process.env.RELAYER_API_URL = originalUrl;
});

describe("proxyToRelayer", () => {
  it("forwards the body verbatim to the built relayer path", async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ success: true, txHash: "0xabc" }), { status: 200 });
    };

    const handler = proxyToRelayer((req) => `/relayer/destinations/${req.params.chain}/activate`);
    const res = fakeRes();
    await handler({ params: { chain: "op" }, body: { commitment: "42" } }, res);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://relayer:8788/relayer/destinations/op/activate");
    assert.equal(calls[0].init.method, "POST");
    // Verbatim: the proxy must not reshape the payload, or it becomes a translation
    // layer that can drift from both sides.
    assert.equal(calls[0].init.body, JSON.stringify({ commitment: "42" }));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { success: true, txHash: "0xabc" });
  });

  it("strips a trailing slash from the configured base URL", async () => {
    process.env.RELAYER_API_URL = "http://relayer:8788/";
    let seen;
    globalThis.fetch = async (url) => {
      seen = url;
      return new Response("{}", { status: 200 });
    };

    await proxyToRelayer(() => "/relayer/quote")({ body: {} }, fakeRes());
    assert.equal(seen, "http://relayer:8788/relayer/quote");
  });

  it("passes the relayer's status through unchanged", async () => {
    // 404 (unknown destination) and 503 (no signer) mean different things to the UI;
    // collapsing them into one code would hide the difference.
    for (const status of [400, 404, 422, 502, 503]) {
      globalThis.fetch = async () => new Response(JSON.stringify({ code: "X" }), { status });
      const res = fakeRes();
      await proxyToRelayer(() => "/relayer/destinations/op/withdraw")({ body: {} }, res);
      assert.equal(res.statusCode, status);
    }
  });

  it("returns 503 when the relayer URL is not configured", async () => {
    delete process.env.RELAYER_API_URL;
    let called = false;
    globalThis.fetch = async () => { called = true; return new Response("{}"); };

    const res = fakeRes();
    await proxyToRelayer(() => "/relayer/quote")({ body: {} }, res);

    assert.equal(res.statusCode, 503);
    assert.equal(called, false);
  });

  it("returns 502 when the relayer is unreachable", async () => {
    globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };

    const res = fakeRes();
    await proxyToRelayer(() => "/relayer/quote")({ body: {} }, res);

    assert.equal(res.statusCode, 502);
    assert.match(res.body.error, /ECONNREFUSED/);
  });

  it("survives an empty or non-JSON error body", async () => {
    // `res.json(await response.json())` used to throw here, turning the relayer's
    // precise status into an opaque failure.
    globalThis.fetch = async () => new Response("", { status: 504 });

    const res = fakeRes();
    await proxyToRelayer(() => "/relayer/quote", { unavailable: "nope" })({ body: {} }, res);

    assert.equal(res.statusCode, 504);
    assert.deepEqual(JSON.parse(res.body), { error: "nope" });
  });

  it("sends no body on a GET", async () => {
    let seenInit;
    globalThis.fetch = async (_url, init) => {
      seenInit = init;
      return new Response("{}", { status: 200 });
    };

    await proxyToRelayer(() => "/relayer/destinations", { method: "GET" })({ body: {} }, fakeRes());
    assert.equal(seenInit.body, undefined);
  });
});

describe("fetchFromRelayer", () => {
  it("returns the parsed body on success", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ configured: true, relayerAddress: "0x1" }), { status: 200 });

    assert.deepEqual(await fetchFromRelayer("/relayer/destinations/op"), {
      configured: true,
      relayerAddress: "0x1",
    });
  });

  it("throws with the relayer's own message on an error status", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ message: "Unknown destination" }), { status: 404 });

    await assert.rejects(
      () => fetchFromRelayer("/relayer/destinations/nope"),
      /Unknown destination/,
    );
  });

  it("throws when the relayer URL is not configured", async () => {
    delete process.env.RELAYER_API_URL;
    await assert.rejects(() => fetchFromRelayer("/relayer/destinations/op"), /not configured/);
  });
});
