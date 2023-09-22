// SPDX-License-Identifier: MIT
pragma solidity 0.8.11;
import { WrappedfCashFactory } from "wrapped-fcash/contracts/proxy/WrappedfCashFactory.sol";

// This contract will be removed before NotionalTradeModule goes to production. It's temporarily included
// to support module development and staging_mainnet testing before Notional deploys their own version of it.
contract WrappedfCashFactoryExperimental is WrappedfCashFactory {
    // Does nothing - disambiguates this contract from WrappedfCashFactory so
    // hardhat-etherscan can verify it.
    uint8 public noop;
    constructor(address _beacon) WrappedfCashFactory(_beacon){
    }
}
