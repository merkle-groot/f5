import { describe, it, expect } from "vitest";
import {
  poseidonFold,
  deriveScopeStarknet,
  calculateContextStarknet,
} from "../../src/crypto.js";
import { poseidon } from "maci-crypto/build/ts/hashing.js";

/**
 * Cross-checks the Starknet context/scope fold against:
 *  - the manual 2-input Poseidon fold, and
 *  - the exact value baked into the Cairo full-flow fixture
 *    (packages/circuits/scripts/gen-withdrawL2-starknet-fixture.ts), which the Cairo pool recomputes
 *    on-chain. If these agree, the SDK, the fixture generator, and the Cairo pool all bind context
 *    identically.
 */
describe("Starknet context binding", () => {
  it("poseidonFold is a left-fold of 2-input Poseidon", () => {
    const xs = [1n, 2n, 3n, 4n, 5n];
    let acc = poseidon([xs[0]!, xs[1]!]);
    for (let i = 2; i < xs.length; i++) acc = poseidon([acc, xs[i]!]);
    expect(poseidonFold(xs)).toBe(acc);
  });

  it("matches the Cairo full-flow fixture context and scope", () => {
    // Values fixed in gen-withdrawL2-starknet-fixture.ts.
    const scope = 12345678901234567890n;
    const withdrawal = {
      processooor: 0xa11cen,
      recipient: 0xb0bn,
      feeRecipient: 0xfeen,
      relayFeeBPS: 100n,
    };
    const EXPECTED_CONTEXT =
      5661813972231078629961255944441926187934156454288745627794153350876846686135n;

    expect(calculateContextStarknet(withdrawal, scope)).toBe(EXPECTED_CONTEXT);
  });

  it("deriveScopeStarknet folds [poolAddress, chainId, asset]", () => {
    const poolAddress = 0x1234n;
    const chainId = 0x534e5f5345504f4c4941n; // SN_SEPOLIA
    const asset = 0x49d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7an;
    expect(deriveScopeStarknet(poolAddress, chainId, asset)).toBe(
      poseidonFold([poolAddress, chainId, asset]),
    );
  });
});
