// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/**
 * @title Arbitrum canonical bridge (L1) interfaces
 * @notice Minimal surface of the Arbitrum Delayed Inbox and L1 Gateway Router used by the pool to
 *         deliver the note message and lock value into a destination Arbitrum shielded pool.
 * @dev L1->L2 messages on Arbitrum are retryable tickets: the caller must prepay
 *      `maxSubmissionCost + gasLimit * maxFeePerGas` (plus any `l2CallValue`) in ETH as `msg.value`.
 *      This is the concrete form of the "gas delivery on destination" open item for Arbitrum.
 */
interface IInbox {
  /**
   * @notice Create a retryable ticket that executes `data` on `to` on L2.
   * @param to Destination L2 address (EVM address; Arbitrum is 20-byte address compatible)
   * @param l2CallValue Callvalue delivered to `to` on L2 (used to move native ETH)
   * @param maxSubmissionCost Max ETH to pay for submitting the ticket
   * @param excessFeeRefundAddress L2 address refunded any unused gas fee
   * @param callValueRefundAddress L2 address refunded `l2CallValue` if the ticket is cancelled
   * @param gasLimit L2 gas limit for auto-redeem
   * @param maxFeePerGas L2 max fee per gas for auto-redeem
   * @param data L2 calldata to execute on `to`
   * @return _ticketId The retryable ticket id
   */
  /**
   * @notice Deposit native ETH to the sender's own address on L2.
   * @dev The dedicated ETH path, distinct from `createRetryableTicket`: it takes no calldata and
   *      needs no gas parameters, because there is nothing to auto-redeem on the L2 side. The
   *      credited amount is `msg.value` less the submission cost. The L2 recipient is `msg.sender`
   *      for an EOA and the *aliased* sender for a contract, so only EOAs can self-fund with it.
   * @return _ticketId The retryable ticket id
   */
  function depositEth() external payable returns (uint256 _ticketId);

  function createRetryableTicket(
    address to,
    uint256 l2CallValue,
    uint256 maxSubmissionCost,
    address excessFeeRefundAddress,
    address callValueRefundAddress,
    uint256 gasLimit,
    uint256 maxFeePerGas,
    bytes calldata data
  ) external payable returns (uint256 _ticketId);
}

interface IL1GatewayRouter {
  /**
   * @notice Returns the L1 gateway responsible for bridging `_token`. The token allowance must be
   *         granted to this gateway (not the router) before calling `outboundTransferCustomRefund`.
   */
  function getGateway(address _token) external view returns (address _gateway);

  /**
   * @notice Bridge `_amount` of `_token` to `_to` on L2 via the token's canonical gateway.
   * @param _token L1 token address
   * @param _refundTo L2 address refunded excess submission/gas fees
   * @param _to Destination L2 address
   * @param _amount Token amount to bridge
   * @param _maxGas L2 gas limit for the token retryable
   * @param _gasPriceBid L2 max fee per gas for the token retryable
   * @param _data ABI-encoded `(uint256 maxSubmissionCost, bytes callHookData)`
   * @return _res Opaque return data from the gateway
   */
  function outboundTransferCustomRefund(
    address _token,
    address _refundTo,
    address _to,
    uint256 _amount,
    uint256 _maxGas,
    uint256 _gasPriceBid,
    bytes calldata _data
  ) external payable returns (bytes memory _res);
}
