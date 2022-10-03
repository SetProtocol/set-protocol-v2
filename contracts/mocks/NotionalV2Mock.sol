// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.6.10;
pragma experimental "ABIEncoderV2";

import { INotionalV2 } from "../interfaces/external/INotionalV2.sol";


contract NotionalV2Mock is INotionalV2 {
    uint88 fCashEstimation;

    function setFCashEstimation(uint88 _fCashEstimation) public {
        fCashEstimation = _fCashEstimation;
    }

   function getfCashLendFromDeposit(
        uint16 currencyId,
        uint256 depositAmountExternal,
        uint256 maturity,
        uint32 minLendRate,
        uint256 blockTime,
        bool useUnderlying
    ) external view override returns (
        uint88 fCashAmount,
        uint8 marketIndex,
        bytes32 encodedTrade
    ) {
        fCashAmount = fCashEstimation;
    }

    function getfCashBorrowFromPrincipal(
        uint16 currencyId,
        uint256 borrowedAmountExternal,
        uint256 maturity,
        uint32 maxBorrowRate,
        uint256 blockTime,
        bool useUnderlying
    ) external view override returns (
        uint88 fCashDebt,
        uint8 marketIndex,
        bytes32 encodedTrade
    ) {
        fCashDebt = fCashEstimation;
    }
}

