// SPDX-License-Identifier: MIT
pragma solidity 0.8.11;
import { nBeaconProxy as nBeaconProxyBase } from "notional-solidity-sdk/contracts/fCash/nBeaconProxy.sol";

contract nBeaconProxy is nBeaconProxyBase {
    constructor(address beacon, bytes memory data) payable nBeaconProxyBase(beacon, data) { }
}
