/*
    Copyright 2022 Set Labs Inc.

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

import "../../../interfaces/external/IUniswapV3Factory.sol";
import "../../../interfaces/IAmmAdapter.sol";
import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";

/**
 * @title UniswapV3AmmAdapter
 * @author Zishan Sami
 *
 * Adapter for Uniswap V3 Router that encodes adding and removing liquidty
 */
contract UniswapV3AmmAdapter is IAmmAdapter {
    using SafeMath for uint256;

    /* ============ External Getter Functions ============ */

    /**
     * Return calldata for the add liquidity call
     *
     * @param  _setToken                Address of the SetToken
     * @param  _pool                    Address of liquidity token
     * @param  _components              Address array required to add liquidity
     * @param  _maxTokensIn             AmountsIn desired to add liquidity
     * @param  _minLiquidity            Min liquidity amount to add
     */
    function getProvideLiquidityCalldata(
        address _setToken,
        address _pool,
        address[] calldata _components,
        uint256[] calldata _maxTokensIn,
        uint256 _minLiquidity
    )
        external
        view
        override
        returns (address target, uint256 value, bytes memory data)
    {
        //TODO
    }

    /**
     * Return calldata for the add liquidity call for a single asset
     */
    function getProvideLiquiditySingleAssetCalldata(
        address /*_setToken*/,
        address /*_pool*/,
        address /*_component*/,
        uint256 /*_maxTokenIn*/,
        uint256 /*_minLiquidity*/
    )
        external
        view
        override
        returns (address /*target*/, uint256 /*value*/, bytes memory /*data*/)
    {
        //TODO
    }

    /**
     * Return calldata for the remove liquidity call
     *
     * @param  _setToken                Address of the SetToken
     * @param  _pool                    Address of liquidity token
     * @param  _components              Address array required to remove liquidity
     * @param  _minTokensOut            AmountsOut minimum to remove liquidity
     * @param  _liquidity               Liquidity amount to remove
     */
    function getRemoveLiquidityCalldata(
        address _setToken,
        address _pool,
        address[] calldata _components,
        uint256[] calldata _minTokensOut,
        uint256 _liquidity
    )
        external
        view
        override
        returns (address target, uint256 value, bytes memory data)
    {
         //TODO
    }

    /**
     * Return calldata for the remove liquidity single asset call
     */
    function getRemoveLiquiditySingleAssetCalldata(
        address /* _setToken */,
        address /*_pool*/,
        address /*_component*/,
        uint256 /*_minTokenOut*/,
        uint256 /*_liquidity*/
    )
        external
        view
        override
        returns (address /*target*/, uint256 /*value*/, bytes memory /*data*/)
    {
         //TODO
    }

    /**
     * Returns the address of the spender
     */
    function getSpenderAddress(address /*_pool*/)
        external
        view
        override
        returns (address spender)
    {
         //TODO
    }

    /**
     * Verifies that this is a valid Uniswap V3 pool
     *
     * @param  _pool          Address of liquidity token
     * @param  _components    Address array of supplied/requested tokens
     */
    function isValidPool(address _pool, address[] memory _components)
        external
        view
        override
        returns (bool)
    {
         //TODO
    }
}