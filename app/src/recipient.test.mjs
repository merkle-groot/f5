import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evmAddressProblem, recipientProblem, starknetAddressProblem } from "./recipient.js";

const LOWER = "0x8d508e422ed2bc102ba364875d2d83c172dc2288";
const CHECKSUMMED = "0x8D508e422eD2Bc102Ba364875d2D83c172DC2288";

describe("evmAddressProblem", () => {
  it("accepts both the lowercase and the checksummed form", () => {
    assert.equal(evmAddressProblem(LOWER), "");
    assert.equal(evmAddressProblem(CHECKSUMMED), "");
  });

  it("treats an empty field as nothing to report rather than an error", () => {
    for (const value of ["", "   ", null, undefined]) assert.equal(evmAddressProblem(value), "");
  });

  it("ignores surrounding whitespace from a paste", () => {
    assert.equal(evmAddressProblem(`  ${LOWER}\n`), "");
  });

  it("names the missing prefix", () => {
    assert.match(evmAddressProblem("8d508e422ed2bc102ba364875d2d83c172dc2288"), /starts with 0x/);
  });

  it("reports the length it actually got", () => {
    assert.match(evmAddressProblem("0x8d508e"), /42 characters — this is 8/);
  });

  it("rejects non-hex digits at the right length", () => {
    assert.match(evmAddressProblem(`0x${"z".repeat(40)}`), /only hex digits/);
  });

  // The digits are right and only the capitalisation is wrong, so "invalid
  // address" would send the user hunting for a typo that does not exist.
  it("distinguishes a checksum failure from a malformed address", () => {
    assert.match(evmAddressProblem(LOWER.toUpperCase().replace("0X", "0x")), /checksum/);
  });
});

describe("starknetAddressProblem", () => {
  it("accepts hex and decimal felts", () => {
    assert.equal(starknetAddressProblem("0x07b336e836269575c4f4fe3fe69e41eff7d918872e8ef2f3cde57abaa035621c"), "");
    assert.equal(starknetAddressProblem("12345"), "");
  });

  it("treats an empty field as nothing to report", () => {
    assert.equal(starknetAddressProblem(""), "");
  });

  it("rejects a value that is not hex or decimal", () => {
    assert.match(starknetAddressProblem("not-a-felt"), /hex \(0x…\) or decimal/);
  });

  it("rejects a value at or above the felt252 bound", () => {
    assert.match(starknetAddressProblem((1n << 251n).toString()), /too large/);
    assert.equal(starknetAddressProblem(((1n << 251n) - 1n).toString()), "");
  });
});

describe("recipientProblem", () => {
  it("applies Starknet rules only to the starknet route", () => {
    // A bare decimal is a fine felt but never an Ethereum address.
    assert.equal(recipientProblem("12345", "starknet"), "");
    assert.notEqual(recipientProblem("12345", "op"), "");
  });

  it("defaults to EVM rules for any other chain key", () => {
    assert.equal(recipientProblem(LOWER, "base"), "");
    assert.equal(recipientProblem(LOWER, undefined), "");
  });
});
