import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCommitment, sendJson } from "./http.mjs";

/** Just enough of an Express response to record what a handler sent. */
function fakeRes() {
  const sent = { status: 200, type: null, body: null };
  return {
    sent,
    status(code) {
      sent.status = code;
      return this;
    },
    type(value) {
      sent.type = value;
      return this;
    },
    send(body) {
      sent.body = body;
      return this;
    },
  };
}

describe("parseCommitment", () => {
  it("accepts decimal and hex integers", () => {
    assert.equal(parseCommitment("123"), 123n);
    assert.equal(parseCommitment("0xff"), 255n);
    assert.equal(parseCommitment(0n), 0n);
  });

  /**
   * The routes read this param inside a try whose catch answered 502. A malformed
   * commitment is the caller's mistake, and reporting it as an upstream chain
   * failure sent people to look at an RPC that was working fine.
   */
  it("rejects a malformed commitment as a client error, not a chain failure", () => {
    assert.throws(
      () => parseCommitment("not-a-number"),
      (error) => {
        assert.equal(error.status, 400);
        assert.match(error.message, /Invalid commitment "not-a-number"/);
        return true;
      },
    );
  });

  it("names the field it was parsing", () => {
    assert.throws(
      () => parseCommitment("", "nullifier"),
      (error) => {
        assert.equal(error.status, 400);
        assert.match(error.message, /Invalid nullifier/);
        return true;
      },
    );
  });
});

describe("sendJson", () => {
  it("stringifies bigints at any depth", () => {
    const res = fakeRes();
    sendJson(res, { proofs: [{ siblings: [1n, 2n], index: 0 }], root: 7n });

    assert.equal(res.sent.status, 200);
    assert.equal(res.sent.type, "application/json");
    assert.deepEqual(JSON.parse(res.sent.body), {
      proofs: [{ siblings: ["1", "2"], index: 0 }],
      root: "7",
    });
  });

  it("carries an explicit status", () => {
    const res = fakeRes();
    sendJson(res, { error: "nope" }, 502);
    assert.equal(res.sent.status, 502);
  });
});
