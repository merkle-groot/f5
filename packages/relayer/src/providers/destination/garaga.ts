import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WithdrawalProof } from "@0xbow/privacy-pools-core-sdk";
import { RelayerError } from "../../exceptions/base.exception.js";

/**
 * Where the `withdrawL2` verifying key lives.
 *
 * `src/` and `dist/` sit at the same depth under the package root, so the relative
 * walk resolves the same whether this runs from ts-node or from the build output.
 * `WITHDRAW_L2_VKEY_PATH` overrides it for the Docker image, where the circuits
 * package may be mounted elsewhere.
 */
function vkeyPath(): string {
  return (
    process.env.WITHDRAW_L2_VKEY_PATH ??
    fileURLToPath(
      new URL(
        "../../../../circuits/build/withdrawL2/groth16_vkey.json",
        import.meta.url,
      ),
    )
  );
}

let vkeyCache: unknown;
let garagaReady: Promise<unknown> | undefined;

/**
 * Turn a snarkjs Groth16 proof into the felt calldata the Cairo verifier expects.
 *
 * This used to be a manual step in the app: the UI made the recipient run the
 * `garaga` PYTHON CLI and paste a felt array into a textarea. Garaga ships the same
 * logic as a WASM package, so the conversion happens server-side and the recipient
 * never sees it.
 */
export async function toGaragaCalldata(
  proof: WithdrawalProof["proof"],
  publicSignals: readonly (string | bigint)[],
): Promise<string[]> {
  const garaga = await import("garaga");
  // `init()` loads the WASM module; awaiting the same promise keeps concurrent
  // withdrawals from initialising it twice.
  garagaReady ??= garaga.init();
  await garagaReady;

  try {
    vkeyCache ??= JSON.parse(readFileSync(vkeyPath(), "utf8"));
  } catch (error) {
    throw RelayerError.unknown(
      `Could not read the withdrawL2 verifying key at ${vkeyPath()}. Build the circuits, or set ` +
        `WITHDRAW_L2_VKEY_PATH. (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  return garaga
    .getGroth16CallData(
      // Garaga's object parser uses fuzzy key matching. Passing the canonical
      // snarkjs object through unchanged lets the `c` matcher select `protocol`
      // ("groth16") before `pi_c` when metadata comes first. Normalize the
      // points to Garaga's exact keys at this dependency boundary instead.
      garaga.parseGroth16ProofFromObject(
        {
          a: proof.pi_a,
          b: proof.pi_b,
          c: proof.pi_c,
          curve: "bn128",
        },
        publicSignals.map((signal) => BigInt(signal)),
      ),
      garaga.parseGroth16VerifyingKeyFromObject(vkeyCache),
      0, // BN254
    )
    .map(String);
}
