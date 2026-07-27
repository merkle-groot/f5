import { describe, expect, it } from "vitest";
import {
  ContractError,
  ErrorCode,
  ProofError,
  SDKError,
} from "../../src/errors/base.error.js";

describe("SDKError", () => {
  it("exposes its details on the instance and in toJSON", () => {
    const error = new SDKError("boom", ErrorCode.NETWORK_ERROR, { attempt: 3 });

    expect(error.code).toBe(ErrorCode.NETWORK_ERROR);
    expect(error.details).toEqual({ attempt: 3 });
    expect(error.toJSON()).toMatchObject({
      name: "SDKError",
      message: "boom",
      code: ErrorCode.NETWORK_ERROR,
      details: { attempt: 3 },
    });
  });

  /**
   * `Error.captureStackTrace` is V8-only. This SDK is also bundled into the browser
   * app, where Firefox and Safari do not define it — an unguarded call there replaced
   * every SDK error with a TypeError.
   */
  it("constructs when the engine has no Error.captureStackTrace", () => {
    const captureStackTrace = Error.captureStackTrace;
    // @ts-expect-error - emulating a non-V8 engine
    delete Error.captureStackTrace;
    try {
      expect(() => new SDKError("no v8 here")).not.toThrow();
    } finally {
      Error.captureStackTrace = captureStackTrace;
    }
  });
});

describe("ContractError", () => {
  it("names itself and keeps its code", () => {
    const error = new ContractError("reverted");

    expect(error).toBeInstanceOf(SDKError);
    expect(error.name).toBe("ContractError");
    expect(error.code).toBe(ErrorCode.CONTRACT_ERROR);
  });

  /**
   * `ContractError` used to call `super(message, code)` and drop `details` on the
   * floor, so the context a caller passed in never reached the log meant to carry it.
   * `ProofError` always forwarded it; the two must agree.
   */
  it("forwards details to the base class, as ProofError does", () => {
    const contract = new ContractError("reverted", ErrorCode.CONTRACT_ERROR, {
      pool: "0xabc",
    });
    const proof = new ProofError("bad", ErrorCode.INVALID_PROOF, {
      pool: "0xabc",
    });

    expect(contract.details).toEqual({ pool: "0xabc" });
    expect(contract.details).toEqual(proof.details);
    expect(contract.toJSON()).toMatchObject({ details: { pool: "0xabc" } });
  });

  it("carries the chain and asset on a missing bridge config", () => {
    const error = ContractError.bridgeConfigNotFound(11155420n, "0xEee");

    expect(error.message).toContain("11155420");
    expect(error.details).toEqual({ chainId: "11155420", asset: "0xEee" });
  });
});
