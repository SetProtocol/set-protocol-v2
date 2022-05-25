// SPDX-License-Identifier: MIT
pragma solidity 0.8.11;
import { WrappedfCashFactory } from "wrapped-fcash/contracts/proxy/WrappedfCashFactory.sol";

contract WrappedfCashFactoryExperimental is WrappedfCashFactory {
    constructor(address _beacon) WrappedfCashFactory(_beacon){
    }
}
