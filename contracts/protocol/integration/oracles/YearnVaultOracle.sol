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

import { PreciseUnitMath } from "../../../lib/PreciseUnitMath.sol";
import { IYearnVault } from "../../../interfaces/external/IYearnVault.sol";
import { IOracle } from "../../../interfaces/IOracle.sol";


/**
 * @title YearnVaultOracle
 * @author Set Protocol, Ember Fund
 *
 * Oracle built to retrieve the Yearn vault price
 */
contract YearnVaultOracle is IOracle
{
    using SafeMath for uint256;
    using PreciseUnitMath for uint256;


    /* ============ State Variables ============ */
    IYearnVault public vault;
    IOracle public underlyingOracle; // Underlying token oracle
    string public dataDescription;

    // Price per share values are scaled by 1e18
    uint256 internal constant scalingFactor = 10 ** 18;

    // CToken Full Unit
    uint256 public cTokenFullUnit;

    // Underlying Asset Full Unit
    uint256 public underlyingFullUnit;

    /* ============ Constructor ============ */

    /*
     * @param  _vault             The address of Yearn Vault Token
     * @param  _underlyingOracle   The address of the underlying oracle
     * @param  _underlyingFullUnit The full unit of the underlying asset
     * @param  _dataDescription    Human readable description of oracle
     */
    constructor(
        IYearnVault _vault,
        IOracle _underlyingOracle,
        uint256 _underlyingFullUnit,
        string memory _dataDescription
    )
        public
    {
        vault = _vault;
        underlyingFullUnit = _underlyingFullUnit;
        underlyingOracle = _underlyingOracle;
        dataDescription = _dataDescription;
    }

    /**
     * Returns the price value of a full vault token denominated in underlyingOracle value
     &
     * The underlying oracle is assumed to return a price of 18 decimal
     * for a single full token of the underlying asset. The derived price
     * of the vault token is then the price of a unit of underlying multiplied
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

        // Retrieve price per share
        uint256 pricePerShare = vault.pricePerShare();
        uint256 normalizedPricePerShare = pricePerShare.preciseDiv(underlyingFullUnit);

        return normalizedPricePerShare.preciseMul(underlyingPrice);
    }
}
