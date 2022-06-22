// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.6.10;
pragma experimental "ABIEncoderV2";


interface INotionalV2 {
   function getfCashLendFromDeposit(
        uint16 currencyId,
        uint256 depositAmountExternal,
        uint256 maturity,
        uint32 minLendRate,
        uint256 blockTime,
        bool useUnderlying
    ) external view returns (
        uint88 fCashAmount,
        uint8 marketIndex,
        bytes32 encodedTrade
    );
}


