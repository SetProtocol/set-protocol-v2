// SPDX-License-Identifier: MIT
pragma solidity 0.8.11;

import "openzeppelin-contracts-V4/proxy/beacon/UpgradeableBeacon.sol";

/// @dev Re-exporting to make available to brownie
/// UpgradeableBeacon is Ownable, default owner is the deployer
contract nUpgradeableBeacon is UpgradeableBeacon {
    // Does nothing - disambiguates this contract from WrappedfCashFactory so
    // hardhat-etherscan can verify it.
    uint8 public noop;
    constructor(address implementation_) UpgradeableBeacon(implementation_) {}
}

