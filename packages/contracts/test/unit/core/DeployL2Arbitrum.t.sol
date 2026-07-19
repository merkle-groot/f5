// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Test} from 'forge-std/Test.sol';

import {DeployL2Arbitrum, IArbSys} from 'script/DeployL2Arbitrum.s.sol';

contract DeployL2ArbitrumHarness is DeployL2Arbitrum {
  function arbitrumBlockNumber() external view returns (uint256) {
    return _arbitrumBlockNumber();
  }
}

contract DeployL2ArbitrumTest is Test {
  DeployL2ArbitrumHarness internal script;

  function setUp() public {
    script = new DeployL2ArbitrumHarness();
  }

  function test_UsesArbitrumL2BlockNumber() public {
    uint256 _parentChainBlock = 11_304_864;
    uint256 _arbitrumL2Block = 289_066_469;
    vm.roll(_parentChainBlock);
    vm.mockCall(address(100), abi.encodeCall(IArbSys.arbBlockNumber, ()), abi.encode(_arbitrumL2Block));

    assertEq(script.arbitrumBlockNumber(), _arbitrumL2Block);
    assertNotEq(script.arbitrumBlockNumber(), block.number);
  }
}
