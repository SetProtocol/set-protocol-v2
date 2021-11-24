/*
  Copyright 2021 Set Labs Inc.

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

  http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.

  SPDX-License-Identifier: Apache License, Version 2.0
*/

pragma solidity 0.6.10;
pragma experimental ABIEncoderV2;

interface IMarketRegistry {
    //
    // STRUCT
    //
    struct MarketInfo {
        address pool;
        uint24 exchangeFeeRatio;
        uint24 uniswapFeeRatio;
        uint24 insuranceFundFeeRatio;
    }

    //
    // EVENT
    //
    event PoolAdded(address indexed baseToken, uint24 indexed feeRatio, address indexed pool);
    event FeeRatioChanged(address baseToken, uint24 feeRatio);
    event InsuranceFundFeeRatioChanged(uint24 feeRatio);
    event MaxOrdersPerMarketChanged(uint8 maxOrdersPerMarket);

    //
    // FUNCTION
    //

    function addPool(address baseToken, uint24 feeRatio) external returns (address);

    function setFeeRatio(address baseToken, uint24 feeRatio) external;

    function setInsuranceFundFeeRatio(address baseToken, uint24 insuranceFundFeeRatioArg) external;

    function setMaxOrdersPerMarket(uint8 maxOrdersPerMarketArg) external;

    //
    // EXTERNAL VIEW
    //

    function getPool(address baseToken) external view returns (address);

    function getFeeRatio(address baseToken) external view returns (uint24);

    function getInsuranceFundFeeRatio(address baseToken) external view returns (uint24);

    function getMarketInfo(address baseToken) external view returns (MarketInfo memory);

    function getQuoteToken() external view returns (address);

    function getUniswapV3Factory() external view returns (address);

    function getMaxOrdersPerMarket() external view returns (uint8);

    function hasPool(address baseToken) external view returns (bool);
}
