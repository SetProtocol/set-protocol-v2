// SPDX-License-Identifier: MIT
pragma solidity 0.8.11;
import { wfCashERC4626 } from "wrapped-fcash/contracts/wfCashERC4626.sol";
import { INotionalV2 } from "wrapped-fcash/interfaces/notional/INotionalV2.sol";

contract WrappedfCash is wfCashERC4626 {
    constructor(INotionalV2 _notionalProxy) wfCashERC4626(_notionalProxy){
    }
}
