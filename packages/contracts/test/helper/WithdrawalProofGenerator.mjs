#!/usr/bin/env node
import {
  PrivacyPoolSDK,
  Circuits,
  getCommitment,
  derivePublicKey,
  computeSharedSecretX,
} from "@f5/privacy-pool-sdk";
import { encodeAbiParameters, decodeAbiParameters } from "viem";

// Fixed Mode-3 stealth vectors (same family as the circuits e2e run). The L1
// `withdrawL1` proof folds the recipient spend key `B` and the ECDH shared
// secret `ssX` into the bridged `C_dest` (pubSignals[1]); the Solidity relay
// only checks the note preimage / roots / context, so these can be deterministic
// here — a botched stealth derivation would only grief a real sender, never the
// on-chain soundness the integration tests exercise.
const RECIPIENT_SPEND_KEY = 987654321098765n; // b
const RECIPIENT_VIEW_KEY = 123456789012345n; // v
const SENDER_EPHEMERAL = 555555555555n; // e

function padSiblings(siblings, treeDepth) {
  const paddedSiblings = [...siblings];
  while (paddedSiblings.length < treeDepth) {
    paddedSiblings.push(0n);
  }
  return paddedSiblings;
}

// Function to temporarily redirect stdout
function withSilentStdout(fn) {
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  return async (...args) => {
    // Temporarily disable stdout/stderr
    process.stdout.write = () => true;
    process.stderr.write = () => true;

    try {
      const result = await fn(...args);
      // Restore stdout/stderr
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      return result;
    } catch (error) {
      // Restore stdout/stderr
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
      throw error;
    }
  };
}

async function main() {
  const [
    existingValue,
    label,
    existingNullifier,
    existingSecret,
    newNullifier,
    newSecret,
    withdrawnValue,
    context,
    stateMerkleProofHex,
    stateTreeDepth,
    aspMerkleProofHex,
    aspTreeDepth,
    bridgedValue,
  ] = process.argv.slice(2);

  try {
    const circuits = new Circuits({ browser: false });
    const sdk = new PrivacyPoolSDK(circuits);

    const stateMerkleProof = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256[]" }],
      stateMerkleProofHex,
    );

    const aspMerkleProof = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256[]" }],
      aspMerkleProofHex,
    );

    const commitment = getCommitment(
      existingValue,
      label,
      existingNullifier,
      existingSecret,
    );

    const paddedStateSiblings = padSiblings(stateMerkleProof[2], 32);
    const paddedAspSiblings = padSiblings(aspMerkleProof[2], 32);

    // Derive the stealth binding: spendingPublicKey B = b·G, ssX = e·V.
    const spendingPublicKey = derivePublicKey(RECIPIENT_SPEND_KEY);
    const viewPublicKey = derivePublicKey(RECIPIENT_VIEW_KEY);
    const sharedSecretX = computeSharedSecretX(SENDER_EPHEMERAL, viewPublicKey);

    // Wrap the proveWithdrawalL1 call with stdout redirection
    const silentProveWithdrawal = withSilentStdout(
      sdk.proveWithdrawalL1.bind(sdk),
    );

    const { proof, publicSignals } = await silentProveWithdrawal(commitment, {
      context,
      bridgedValue,
      withdrawnValue,
      stateMerkleProof: {
        root: stateMerkleProof[0],
        leaf: commitment.hash,
        index: stateMerkleProof[1],
        siblings: paddedStateSiblings,
      },
      aspMerkleProof: {
        root: aspMerkleProof[0],
        leaf: commitment.hash,
        index: aspMerkleProof[1],
        siblings: paddedAspSiblings,
      },
      stateRoot: stateMerkleProof[0],
      stateTreeDepth: parseInt(stateTreeDepth),
      aspRoot: aspMerkleProof[0],
      aspTreeDepth: parseInt(aspTreeDepth),
      spendingPublicKey,
      sharedSecretX,
      newSecret,
      newNullifier,
    });

    const withdrawalProof = {
      _pA: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])],
      _pB: [
        [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
        [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
      ],
      _pC: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])],
      // Mode-3 withdrawL1 emits 10 public signals, including the net bridged value.
      _pubSignals: [
        publicSignals[0],
        publicSignals[1],
        publicSignals[2],
        publicSignals[3],
        publicSignals[4],
        publicSignals[5],
        publicSignals[6],
        publicSignals[7],
        publicSignals[8],
        publicSignals[9],
      ].map((x) => BigInt(x)),
    };

    const encodedProof = encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "_pA", type: "uint256[2]" },
            { name: "_pB", type: "uint256[2][2]" },
            { name: "_pC", type: "uint256[2]" },
            { name: "_pubSignals", type: "uint256[10]" },
          ],
        },
      ],
      [withdrawalProof],
    );

    process.stdout.write(encodedProof);
    process.exit(0);
  } catch (e) {
    // console.error(e);
    process.exit(1);
  }
}

main().catch(() => process.exit(1));
