// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/**
 * @title Starknet canonical bridge (L1) interfaces
 * @notice Minimal StarkGate surface used to bridge value and deliver the note commitment to a
 *         destination Starknet (Cairo) shielded pool in one operation.
 * @dev Starknet addresses are field elements (felt252, < ~2**251), not 20-byte EVM addresses, so
 *      the destination pool is carried as `uint256`. Callback messages are `uint256[]` arrays of
 *      felts; a Poseidon-BN254 commitment must be split into low/high 128-bit felts by the caller.
 *      StarkGate's single L1->L2 fee is paid as `msg.value`.
 */
interface IStarkgateBridge {
  /**
   * @notice Deposit `amount` of `token` to `l2Recipient` on Starknet via StarkGate.
   * @dev ERC20 path only. StarkGate identifies the native asset with its own sentinel
   *      (`0x...455448`), NOT this repo's `Constants.NATIVE_ASSET` (`0xEeee...EEeE`) — passing the
   *      latter reverts with `TOKEN_NOT_SERVICED`. Use {IStarkgateEthBridge} for native instead.
   * @param token L1 token address
   * @param amount Token amount to bridge
   * @param l2Recipient Destination Starknet address (felt252)
   */
  function deposit(address token, uint256 amount, uint256 l2Recipient) external payable;

  /**
   * @notice Bridge tokens, then invoke `on_receive` on the L2 recipient with `_message`.
   * @dev StarkGate credits the recipient before the callback, which guarantees backing is present
   *      before the destination commitment is accepted.
   */
  function depositWithMessage(
    address token,
    uint256 amount,
    uint256 l2Recipient,
    uint256[] calldata message
  ) external payable;
}

interface IStarkgateEthBridge {
  /**
   * @notice Deposit `amount` of native ETH to `l2Recipient` on Starknet via the StarkGate ETH bridge.
   * @dev The token-less overload exposed by `StarkWare_StarknetEthBridge_2.0`. The bridged value and
   *      the L1->L2 message fee both ride in `msg.value` (`msg.value == amount + fee`). This avoids
   *      the token-sentinel mismatch described in {IStarkgateBridge.deposit}.
   * @param amount ETH amount to bridge
   * @param l2Recipient Destination Starknet address (felt252)
   */
  function deposit(uint256 amount, uint256 l2Recipient) external payable;

  /**
   * @notice Native-ETH form of StarkGate's message-bearing deposit.
   * @dev The upgraded legacy ETH bridge exposes the common token-explicit ABI and identifies ETH
   *      with `address(0x455448)`.
   */
  function depositWithMessage(
    address token,
    uint256 amount,
    uint256 l2Recipient,
    uint256[] calldata message
  ) external payable;
}
