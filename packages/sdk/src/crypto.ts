import { mnemonicToAccount } from "viem/accounts";
import { bytesToBigInt } from "viem/utils";
import { poseidon } from "maci-crypto/build/ts/hashing.js";
import { LeanIMT, LeanIMTMerkleProof } from "@zk-kit/lean-imt";
import {
  ErrorCode,
  PrivacyPoolError,
} from "./exceptions/privacyPool.exception.js";
import {
  Commitment,
  Hash,
  Secret,
  Withdrawal,
  RelayWithdrawal,
  RelayData,
  L2RelayData,
  MasterKeys,
} from "./types/index.js";
import { encodeAbiParameters, Hex, keccak256, numberToHex } from "viem";
import { SNARK_SCALAR_FIELD } from "./constants.js";

/**
 * Validates that a bigint value is not zero
 * @param value The value to check
 * @param name The name of the value for the error message
 * @throws {PrivacyPoolError} If the value is zero
 */
function validateNonZero(value: bigint, name: string) {
  if (value === BigInt(0)) {
    throw new PrivacyPoolError(
      ErrorCode.INVALID_VALUE,
      `Invalid input: '${name}' cannot be zero.`,
    );
  }
}

/**
 * Derive the two master keys that seed every L1 note secret, from the mnemonic.
 *
 * `masterNullifier` and `masterSecret` come from HD accounts 0 and 1. Everything
 * a deposit needs is then `Poseidon(master, scope, index)`, which is what makes
 * notes recoverable from the phrase alone.
 *
 * CRITICAL — read before touching the derivation:
 *
 * This previously ran the 32-byte HD key through viem's `bytesToNumber`, which
 * returns a JavaScript `number` (an IEEE-754 double). A 256-bit key is ~7.8e76,
 * far past `Number.MAX_SAFE_INTEGER`, so the double kept only its 53-bit mantissa
 * and SILENTLY ROUNDED — zeroing the low ~203 bits. The master keys therefore had
 * roughly 53 bits of entropy each instead of 256, and `BigInt(key1)` was not even
 * the real private key. `bytesToBigInt` is the correct conversion; `bytesToNumber`
 * must never be used on key material.
 *
 * Changing this CHANGES EVERY DERIVED NOTE SECRET. It was safe to fix only because
 * the pool had zero deposits at the time. Anyone altering it later must treat it as
 * a migration: existing notes would become underivable, and therefore unspendable.
 */
export function generateMasterKeys(mnemonic: string): MasterKeys {
  if (!mnemonic) {
    throw new PrivacyPoolError(
      ErrorCode.INVALID_VALUE,
      "Invalid input: mnemonic phrase is required."
    );
  }

  const key1 = bytesToBigInt(
    mnemonicToAccount(mnemonic, { accountIndex: 0 }).getHdKey().privateKey!,
  );

  const key2 = bytesToBigInt(
    mnemonicToAccount(mnemonic, { accountIndex: 1 }).getHdKey().privateKey!,
  );

  const masterNullifier = poseidon([key1]) as Secret;
  const masterSecret = poseidon([key2]) as Secret;

  return { masterNullifier, masterSecret };
}

/**
 * Generates a nullifier and secret pair for a deposit commitment.
 *
 * @param {MasterKeys} keys - The master keys pair.
 * @param {Hash} scope - The pool scope.
 * @param {bigint} index - The pool account index for the scope.
 * @returns {Secret, Secret} The commitment nullifier and secret pair.
 */
export function generateDepositSecrets(
  keys: MasterKeys,
  scope: Hash,
  index: bigint,
): { nullifier: Secret; secret: Secret } {
  const nullifier = poseidon([keys.masterNullifier, scope, index]) as Secret;
  const secret = poseidon([keys.masterSecret, scope, index]) as Secret;

  return { nullifier, secret };
}

/**
 * Generates a nullifier and secret pair for a withdrawal commitment.
 *
 * @param {MasterKeys} keys - The master keys pair.
 * @param {Hash} label - The deposit commitment label.
 * @param {bigint} index - The withdrawal index for the pool account.
 * @returns {Secret, Secret} The commitment nullifier and secret pair.
 */
export function generateWithdrawalSecrets(
  keys: MasterKeys,
  label: Hash,
  index: bigint,
): { nullifier: Secret; secret: Secret } {
  const nullifier = poseidon([keys.masterNullifier, label, index]) as Secret;
  const secret = poseidon([keys.masterSecret, label, index]) as Secret;

  return { nullifier, secret };
}

/**
 * Computes a Poseidon hash for the given nullifier and secret.
 *
 * @param {Secret} nullifier - The nullifier to hash.
 * @param {Secret} secret - The secret to hash.
 * @returns {Hash} The Poseidon hash.
 */
export function hashPrecommitment(nullifier: Secret, secret: Secret): Hash {
  return poseidon([nullifier, secret]) as Hash;
}

/**
 * Generates a commitment using the given parameters.
 *
 * @param {bigint} value - The value associated with the commitment.
 * @param {bigint} label - The label used for the commitment.
 * @param {Secret} nullifier - The nullifier used in the precommitment.
 * @param {Secret} secret - The secret used in the precommitment.
 * @returns {Commitment} The generated commitment object.
 */
export function getCommitment(
  value: bigint,
  label: bigint,
  nullifier: Secret,
  secret: Secret,
): Commitment {
  validateNonZero(nullifier as bigint, "nullifier");
  validateNonZero(label, "label");
  validateNonZero(secret as bigint, "secret");

  const precommitment = {
    hash: hashPrecommitment(nullifier, secret),
    nullifier,
    secret,
  };

  const hash = poseidon([value, label, precommitment.hash]) as Hash;

  return {
    hash,
    nullifierHash: precommitment.hash,
    preimage: {
      value,
      label,
      precommitment,
    },
  };
}

/**
 * Generates a Merkle inclusion proof for a given leaf in a set of leaves.
 *
 * @param {bigint[]} leaves - Array of leaves for the Lean Incremental Merkle tree.
 * @param {bigint} leaf - The specific leaf to generate the inclusion proof for.
 * @returns {LeanIMTMerkleProof<bigint>} A lean incremental Merkle tree inclusion proof.
 * @throws {Error} If the leaf is not found in the leaves array.
 */
export function generateMerkleProof(
  leaves: bigint[],
  leaf: bigint,
): LeanIMTMerkleProof<bigint> {
  const tree = new LeanIMT<bigint>((a: bigint, b: bigint) => poseidon([a, b]));

  tree.insertMany(leaves);

  const leafIndex = tree.indexOf(leaf);

  // if leaf does not exist in tree, throw error
  if (leafIndex === -1) {
    throw new PrivacyPoolError(
      ErrorCode.MERKLE_ERROR,
      "Leaf not found in the leaves array.",
    );
  }

  const proof = tree.generateProof(leafIndex);

  if (proof.siblings.length < 32) {
    proof.siblings = [
      ...proof.siblings,
      ...Array(32 - proof.siblings.length).fill(BigInt(0)),
    ];
  }

  return proof;
}

export function bigintToHash(value: bigint): Hash {
  return `0x${value.toString(16).padStart(64, "0")}` as unknown as Hash;
}

export function bigintToHex(num: bigint | string | undefined): Hex {
  if (num === undefined) throw new Error("Undefined bigint value!");
  return `0x${BigInt(num).toString(16).padStart(64, "0")}`;
}

/**
 * ABI-encodes the L1 relay payload into the `data` field of a
 * {@link RelayWithdrawal}. Carries the ephemeral key + view tag the recipient
 * scans for. Mirrors the tuple layout in `e2e/relay.mjs`.
 */
export function encodeRelayData(data: RelayData): Hex {
  return encodeAbiParameters(
    [
      {
        name: "data",
        type: "tuple",
        components: [
          { name: "recipient", type: "address" },
          { name: "feeRecipient", type: "address" },
          { name: "ephemeralKey", type: "uint256[2]" },
          { name: "viewTag", type: "bytes1" },
          { name: "relayFeeBPS", type: "uint256" },
        ],
      },
    ],
    [
      {
        recipient: data.recipient,
        feeRecipient: data.feeRecipient,
        ephemeralKey: [data.ephemeralKey[0], data.ephemeralKey[1]],
        viewTag: data.viewTag,
        relayFeeBPS: data.relayFeeBPS,
      },
    ],
  );
}

/**
 * ABI-encodes the L2 spend payload into the `data` field of a
 * {@link Withdrawal}. No ephemeral key / view tag — those matter only at note
 * delivery. Mirrors the tuple layout in `e2e/l2withdraw.mjs`.
 */
export function encodeL2RelayData(data: L2RelayData): Hex {
  return encodeAbiParameters(
    [
      {
        name: "data",
        type: "tuple",
        components: [
          { name: "recipient", type: "address" },
          { name: "feeRecipient", type: "address" },
          { name: "relayFeeBPS", type: "uint256" },
        ],
      },
    ],
    [
      {
        recipient: data.recipient,
        feeRecipient: data.feeRecipient,
        relayFeeBPS: data.relayFeeBPS,
      },
    ],
  );
}

/**
 * Calculates the context hash for the L2 spend leg:
 * `keccak256(abi.encode(Withdrawal{processooor,data}, scope)) % F`.
 */
export function calculateContext(withdrawal: Withdrawal, scope: Hash): string {
  const hash =
    BigInt(
      keccak256(
        encodeAbiParameters(
          [
            {
              name: "withdrawal",
              type: "tuple",
              components: [
                { name: "processooor", type: "address" },
                { name: "data", type: "bytes" },
              ],
            },
            { name: "scope", type: "uint256" },
          ],
          [
            {
              processooor: withdrawal.processooor,
              data: withdrawal.data,
            },
            scope,
          ],
        ),
      ),
    ) % SNARK_SCALAR_FIELD;
  return numberToHex(hash);
}

/**
 * Calculates the context hash for the L1 relay leg:
 * `keccak256(abi.encode(RelayWithdrawal{chainId,data}, scope)) % F`.
 *
 * Distinct from {@link calculateContext} because the L1 relay shape has a
 * `chainId` (uint256) where the L2 shape has a `processooor` (address); the
 * two hash differently and must not be swapped. Mirrors `e2e/relay.mjs`.
 */
export function calculateRelayContext(
  withdrawal: RelayWithdrawal,
  scope: Hash,
): string {
  const hash =
    BigInt(
      keccak256(
        encodeAbiParameters(
          [
            {
              name: "withdrawal",
              type: "tuple",
              components: [
                { name: "chainId", type: "uint256" },
                { name: "data", type: "bytes" },
              ],
            },
            { name: "scope", type: "uint256" },
          ],
          [
            {
              chainId: withdrawal.chainId,
              data: withdrawal.data,
            },
            scope,
          ],
        ),
      ),
    ) % SNARK_SCALAR_FIELD;
  return numberToHex(hash);
}

/**
 * Left-fold of the 2-input BN254 Poseidon over a list of field elements.
 *
 * The counterpart of `poseidon_fold` in the Starknet pool (`packages/starknet-pool/src/hashing.cairo`).
 * Garaga exposes only a 2-input Poseidon on Starknet, so the Cairo side derives `context`/`scope` as
 * this fold; the SDK must mirror it exactly. Output is a BN254 field element (no mod-p reduction).
 *
 * @param inputs At least two field elements.
 */
export function poseidonFold(inputs: bigint[]): bigint {
  if (inputs.length < 2) throw new Error("poseidonFold: need >= 2 inputs");
  // The length guard above makes every index below in-bounds; `!` is what tells
  // `noUncheckedIndexedAccess` that.
  let acc = poseidon([inputs[0]!, inputs[1]!]);
  for (let i = 2; i < inputs.length; i++) {
    acc = poseidon([acc, inputs[i]!]);
  }
  return acc;
}

/**
 * The Starknet-pool `scope`, mirroring `StarknetPrivacyPool`'s constructor:
 * `PoseidonBN254([poolAddress, chainId, asset])`. All inputs are Starknet felts (< 2**251 < F).
 */
export function deriveScopeStarknet(
  poolAddress: bigint,
  chainId: bigint,
  asset: bigint,
): bigint {
  return poseidonFold([poolAddress, chainId, asset]);
}

/**
 * A flattened Starknet withdrawal request — the counterpart of the Cairo `Withdrawal` struct.
 * All addresses are Starknet felts.
 */
export interface StarknetWithdrawal {
  processooor: bigint;
  recipient: bigint;
  feeRecipient: bigint;
  relayFeeBPS: bigint;
}

/**
 * The Starknet L2-spend `context`, mirroring `StarknetPrivacyPool._compute_context`:
 * `PoseidonBN254([processooor, recipient, feeRecipient, relayFeeBPS, scope])`.
 *
 * Unlike {@link calculateContext} (EVM keccak/abi.encode), this is a Poseidon fold: the `withdrawL2`
 * circuit treats `context` as opaque, so the derivation is a pool<->SDK convention, and Poseidon is
 * far cheaper to reproduce in Cairo than Solidity ABI-encoding. Returns a BN254 field element.
 */
export function calculateContextStarknet(
  withdrawal: StarknetWithdrawal,
  scope: bigint,
): bigint {
  return poseidonFold([
    withdrawal.processooor,
    withdrawal.recipient,
    withdrawal.feeRecipient,
    withdrawal.relayFeeBPS,
    scope,
  ]);
}
