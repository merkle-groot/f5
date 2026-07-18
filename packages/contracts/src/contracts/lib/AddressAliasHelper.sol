// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/**
 * @title AddressAliasHelper
 * @notice Applies/undoes the Arbitrum L1->L2 address alias.
 * @dev When an L1 contract sends a message to L2 through the Arbitrum canonical bridge, the L2
 *      `msg.sender` is the L1 address offset by a fixed constant. Undoing the offset recovers the
 *      original L1 sender, which is how an L2 contract authenticates the calling L1 contract without
 *      a messenger. Mirrors the canonical Arbitrum implementation.
 */
library AddressAliasHelper {
  /// @notice The fixed offset added to an L1 address when it becomes the L2 `msg.sender`
  uint160 internal constant OFFSET = uint160(0x1111000000000000000000000000000000001111);

  /**
   * @notice Convert an L1 address to the aliased address seen as `msg.sender` on L2
   * @param _l1Address The L1 address
   * @return _l2Address The corresponding aliased L2 address
   */
  function applyL1ToL2Alias(address _l1Address) internal pure returns (address _l2Address) {
    unchecked {
      _l2Address = address(uint160(_l1Address) + OFFSET);
    }
  }

  /**
   * @notice Recover the L1 address from an aliased L2 `msg.sender`
   * @param _l2Address The aliased L2 address (an L1->L2 message's `msg.sender`)
   * @return _l1Address The original L1 sender
   */
  function undoL1ToL2Alias(address _l2Address) internal pure returns (address _l1Address) {
    unchecked {
      _l1Address = address(uint160(_l2Address) - OFFSET);
    }
  }
}
