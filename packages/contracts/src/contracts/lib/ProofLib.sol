// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/**
 * @title ProofLib
 * @notice Facilitates accessing the public signals of a Groth16 proof.
 * @custom:semver 0.1.0
 */
library ProofLib {
  /*///////////////////////////////////////////////////////////////
                         WITHDRAWAL PROOF 
  //////////////////////////////////////////////////////////////*/

  /**
   * @notice Struct containing Groth16 proof elements and public signals for withdrawal verification
   * @dev The public signals array must match the order of public inputs/outputs in the circuit
   * @param pA First elliptic curve point (π_A) of the Groth16 proof, encoded as two field elements
   * @param pB Second elliptic curve point (π_B) of the Groth16 proof, encoded as 2x2 matrix of field elements
   * @param pC Third elliptic curve point (π_C) of the Groth16 proof, encoded as two field elements
   * @param pubSignals Array of public inputs and outputs:
   *        - [0] newCommitmentHashL1: Hash of the L1 change note
   *        - [1] newCommitmentHashL2: Hash of the bridged destination note (C_dest)
   *        - [2] existingNullifierHash: Hash of the nullifier being spent
   *        - [3] withdrawnValue: Gross amount spent from the L1 note
   *        - [4] bridgedValue: Net value delivered to L2 after the relay fee
   *        - [5] stateRoot: Current state root of the privacy pool
   *        - [6] stateTreeDepth: Current depth of the state tree
   *        - [7] ASPRoot: Current root of the Association Set Provider tree
   *        - [8] ASPTreeDepth: Current depth of the ASP tree
   *        - [9] context: Context value for the withdrawal operation
   * NOTE: circom derives this order from the TEMPLATE's signal DECLARATION order
   * (the three outputs first, then the inputs) — NOT from the order listed in
   * `component main {public [...]}`. `withdrawL1.circom` declares `bridgedValue`
   * second, immediately after `withdrawnValue`, so it sits at index 4 even though
   * the `main` list names it last. Reading it at [9] (and thus `stateRoot` at [4])
   * made every `relay()` revert with `ContextMismatch`.
   * Ground truth: `packages/circuits/build/withdrawL1/withdrawL1.sym`.
   */
  struct WithdrawProof {
    uint256[2] pA;
    uint256[2][2] pB;
    uint256[2] pC;
    uint256[10] pubSignals;
  }

  /**
   * @notice Retrieves the new commitment hash from the proof's public signals
   * @param _p The proof containing the public signals
   * @return The hash of the new commitment being created
   */
  function newCommitmentHashL1(WithdrawProof memory _p) internal pure returns (uint256) {
    return _p.pubSignals[0];
  }

  /**
  * @notice Retrieves the new commitment hash from the proof's public signals for L2
  * @param _p The proof containing the public signals
  * @return The hash of the new commitment being created for L2
  */
  function newCommitmentHashL2(WithdrawProof memory _p) internal pure returns (uint256) {
    return _p.pubSignals[1];
  }

  /**
   * @notice Retrieves the existing nullifier hash from the proof's public signals
   * @param _p The proof containing the public signals
   * @return The hash of the nullifier being spent in this withdrawal
   */
  function existingNullifierHash(WithdrawProof memory _p) internal pure returns (uint256) {
    return _p.pubSignals[2];
  }

  /**
   * @notice Retrieves the withdrawn value from the proof's public signals
   * @param _p The proof containing the public signals
   * @return The gross amount spent from the L1 note
   */
  function withdrawnValue(WithdrawProof memory _p) internal pure returns (uint256) {
    return _p.pubSignals[3];
  }

  /**
   * @notice Retrieves the bridged value from the proof's public signals
   * @param _p The proof containing the public signals
   * @return The net value delivered to L2 after the relay fee
   */
  function bridgedValue(WithdrawProof memory _p) internal pure returns (uint256) {
    return _p.pubSignals[4];
  }

  /**
   * @notice Retrieves the state root from the proof's public signals
   * @param _p The proof containing the public signals
   * @return The root of the state tree at time of proof generation
   */
  function stateRoot(WithdrawProof memory _p) internal pure returns (uint256) {
    return _p.pubSignals[5];
  }

  /**
   * @notice Retrieves the state tree depth from the proof's public signals
   * @param _p The proof containing the public signals
   * @return The depth of the state tree at time of proof generation
   */
  function stateTreeDepth(WithdrawProof memory _p) internal pure returns (uint256) {
    return _p.pubSignals[6];
  }

  /**
   * @notice Retrieves the ASP root from the proof's public signals
   * @param _p The proof containing the public signals
   * @return The latest root of the ASP tree at time of proof generation
   */
  function ASPRoot(WithdrawProof memory _p) internal pure returns (uint256) {
    return _p.pubSignals[7];
  }

  /**
   * @notice Retrieves the ASP tree depth from the proof's public signals
   * @param _p The proof containing the public signals
   * @return The depth of the ASP tree at time of proof generation
   */
  function ASPTreeDepth(WithdrawProof memory _p) internal pure returns (uint256) {
    return _p.pubSignals[8];
  }

  /**
   * @notice Retrieves the context value from the proof's public signals
   * @param _p The proof containing the public signals
   * @return The context value binding the proof to specific withdrawal data
   */
  function context(WithdrawProof memory _p) internal pure returns (uint256) {
    return _p.pubSignals[9];
  }

  /*///////////////////////////////////////////////////////////////
                          RAGEQUIT PROOF 
  //////////////////////////////////////////////////////////////*/

  /**
   * @notice Struct containing Groth16 proof elements and public signals for ragequit verification
   * @dev The public signals array must match the order of public inputs/outputs in the circuit
   * @param pA First elliptic curve point (π_A) of the Groth16 proof, encoded as two field elements
   * @param pB Second elliptic curve point (π_B) of the Groth16 proof, encoded as 2x2 matrix of field elements
   * @param pC Third elliptic curve point (π_C) of the Groth16 proof, encoded as two field elements
   * @param pubSignals Array of public inputs and outputs:
   *        - [0] commitmentHash: Hash of the commitment being ragequit
   *        - [1] nullifierHash: Nullifier hash of commitment being ragequit
   *        - [2] value: Value of the commitment being ragequit
   *        - [3] label: Label of commitment
   */
  struct RagequitProof {
    uint256[2] pA;
    uint256[2][2] pB;
    uint256[2] pC;
    uint256[4] pubSignals;
  }

  /**
   * @notice Retrieves the new commitment hash from the proof's public signals
   * @param _p The ragequit proof containing the public signals
   * @return The new commitment hash
   */
  function commitmentHash(RagequitProof memory _p) internal pure returns (uint256) {
    return _p.pubSignals[0];
  }

  /**
   * @notice Retrieves the nullifier hash from the proof's public signals
   * @param _p The ragequit proof containing the public signals
   * @return The nullifier hash
   */
  function nullifierHash(RagequitProof memory _p) internal pure returns (uint256) {
    return _p.pubSignals[1];
  }

  /**
   * @notice Retrieves the commitment value from the proof's public signals
   * @param _p The ragequit proof containing the public signals
   * @return The commitment value
   */
  function value(RagequitProof memory _p) internal pure returns (uint256) {
    return _p.pubSignals[2];
  }

  /**
   * @notice Retrieves the commitment label from the proof's public signals
   * @param _p The ragequit proof containing the public signals
   * @return The commitment label
   */
  function label(RagequitProof memory _p) internal pure returns (uint256) {
    return _p.pubSignals[3];
  }
}
