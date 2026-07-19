import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { WithdrawalProof } from "@0xbow/privacy-pools-core-sdk";
import { describe, expect, it } from "vitest";
import { toGaragaCalldata } from "../../src/providers/destination/garaga.js";

const fixturePath = (name: string): string =>
  fileURLToPath(
    new URL(`../../../starknet-pool/tests/fixtures/${name}`, import.meta.url),
  );

const rawProof = JSON.parse(readFileSync(fixturePath("proof.json"), "utf8"));
const publicSignals = JSON.parse(
  readFileSync(fixturePath("public.json"), "utf8"),
) as string[];
const expectedProofFelts = readFileSync(
  fileURLToPath(
    new URL(
      "../../../starknet-pool/tests/withdraw_calldata.txt",
      import.meta.url,
    ),
  ),
  "utf8",
)
  .trim()
  .split(/\s+/)
  .map(BigInt);

// Deliberately reproduce the request schema's metadata-first insertion order.
// Garaga 1.1.0 previously matched point C to `protocol: "groth16"` for this shape.
const metadataFirstProof = {
  protocol: rawProof.protocol,
  curve: rawProof.curve,
  pi_a: rawProof.pi_a,
  pi_b: rawProof.pi_b,
  pi_c: rawProof.pi_c,
} as WithdrawalProof["proof"];

describe("toGaragaCalldata", () => {
  it("converts a metadata-first snarkjs proof to decimal felt calldata", async () => {
    const calldata = await toGaragaCalldata(metadataFirstProof, publicSignals);

    expect(calldata.length).toBeGreaterThan(0);
    expect(calldata.every((felt) => /^\d+$/.test(felt))).toBe(true);
    expect(calldata[0]).toBe(expectedProofFelts.length.toString());
    expect(calldata.slice(1).map(BigInt)).toEqual(expectedProofFelts);
  });

  it("still rejects a malformed proof point", async () => {
    const malformedProof = {
      ...metadataFirstProof,
      pi_c: [
        "not-a-point",
        metadataFirstProof.pi_c[1],
        metadataFirstProof.pi_c[2],
      ],
    } as WithdrawalProof["proof"];

    await expect(
      toGaragaCalldata(malformedProof, publicSignals),
    ).rejects.toThrow();
  });
});
