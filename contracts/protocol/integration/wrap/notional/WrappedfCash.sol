// SPDX-License-Identifier: MIT
pragma solidity 0.8.11;
import { WrappedfCash as WrappedfCashBase } from "notional-solidity-sdk/contracts/fCash/WrappedfCash.sol";
import { NotionalProxy } from "notional-solidity-sdk/interfaces/notional/NotionalProxy.sol";

contract WrappedfCash is WrappedfCashBase {
    constructor(NotionalProxy _notionalProxy) WrappedfCashBase(_notionalProxy){
    }
}
