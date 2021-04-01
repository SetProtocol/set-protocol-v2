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
*/

pragma solidity 0.6.10;

import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { ICToken } from "../../../interfaces/external/ICToken.sol";
import { IOracle } from "../../../interfaces/IOracle.sol";


/**
 * @title CTokenOracle
 * @author Set Protocol
 *
 * Oracle built to retrieve the cToken price
 */
contract CTokenOracle is IOracle
{
    using SafeMath for uint256;

    /* ============ State Variables ============ */
    ICToken public cToken;
    IOracle public underlyingOracle; // Underlying token oracle
    string public dataDescription;

    // Exchange Rate values are scaled by 1e18
    uint256 internal constant scalingFactor = 10 ** 18;

    // CToken Full Unit
    uint256 public cTokenFullUnit;

    // Underlying Asset Full Unit
    uint256 public underlyingFullUnit;

    /* ============ Constructor ============ */

    /*
     * @param  _cToken             The address of Compound Token
     * @param  _underlyingOracle   The address of the underlying oracle
     * @param  _cTokenFullUnit     The full unit of the Compound Token
     * @param  _underlyingFullUnit The full unit of the underlying asset
     * @param  _dataDescription    Human readable description of oracle
     */
    constructor(
        ICToken _cToken,
        IOracle _underlyingOracle,
        uint256 _cTokenFullUnit,
        uint256 _underlyingFullUnit,
        string memory _dataDescription
    )
        public
    {
        cToken = _cToken;
        cTokenFullUnit = _cTokenFullUnit;
        underlyingFullUnit = _underlyingFullUnit;
        underlyingOracle = _underlyingOracle;
        dataDescription = _dataDescription;
    }

    /**
     * Returns the price value of a full cToken denominated in underlyingOracle value
     &
     * The underlying oracle is assumed to return a price of 18 decimal
     * for a single full token of the underlying asset. The derived price
     * of the cToken is then the price of a unit of underlying multiplied
     * by the exchangeRate, adjusted for decimal differences, and descaled.
     */
    function read()
        external
        override
        view
        returns (uint256)
    {
        // Retrieve the price of the underlying
        uint256 underlyingPrice = underlyingOracle.read();

        // Retrieve cToken underlying to cToken stored conversion rate
        uint256 conversionRate = cToken.exchangeRateStored();

        // Price of underlying is the price value / Token * conversion / scaling factor
        // Values need to be converted based on full unit quantities
        return underlyingPrice
            .mul(conversionRate)
            .mul(cTokenFullUnit)
            .div(underlyingFullUnit)
            .div(scalingFactor);
    }
}
