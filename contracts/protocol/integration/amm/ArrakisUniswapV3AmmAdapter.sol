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

import "@openzeppelin/contracts/math/SafeMath.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";

import "../../../interfaces/IAmmAdapter.sol";
import "../../../interfaces/external/IArrakisVaultV1.sol";

/**
 * @title UniswapV3AmmAdapter
 * @author Zishan Sami
 *
 * Adapter for Arrakis Vault representing Uniswap V3 liquidity position that encodes adding and removing liquidty
 */
contract ArrakisUniswapV3AmmAdapter is IAmmAdapter {
    using SafeMath for uint256;

    /* ============ State Variables ============ */

    // Address of Arrakis Router contract
    address public immutable router;

    // UniswapV3 factory contract
    IUniswapV3Factory public immutable uniV3Factory;

    // Internal function string for adding liquidity
    string internal constant ADD_LIQUIDITY =
        "addLiquidity(address,uint256,uint256,uint256,uint256,address)";
    // Internal function string for removing liquidity
    string internal constant REMOVE_LIQUIDITY =
        "removeLiquidity(address,uint256,uint256,uint256,address)";

    /* ============ Constructor ============ */

    /**
     * Set state variables
     *
     * @param _router          Address of Arrakis Router contract
     * @param _uniV3Factory    Address of UniswapV3 Factory contract
     */
    constructor(address _router, address _uniV3Factory) public {
        require(_router != address(0),"_router address must not be zero address");
        require(_uniV3Factory != address(0),"_uniV3Factory address must not be zero address");
        router = _router;
        uniV3Factory = IUniswapV3Factory(_uniV3Factory);
    }

    /* ============ External Getter Functions ============ */

    /**
     * Return calldata for the add liquidity call
     *
     * @param  _setToken                Address of the SetToken
     * @param  _pool                    Address of liquidity token
     * @param  _components              Token address array required to remove liquidity
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
        address setToken = _setToken;
        address[] memory components = _components;
        uint256[] memory maxTokensIn = _maxTokensIn;
        uint256 minLiquidity = _minLiquidity;

        require(maxTokensIn[0] > 0 && maxTokensIn[1] > 0, "Component quantity must be nonzero");

        IArrakisVaultV1 arrakisVaultPool = IArrakisVaultV1(_pool);

        // Sort the amount in order of tokens stored in Arrakis Pool
        (uint256 maxTokensInA, uint256 maxTokensInB) = _getOrderedAmount(components[0], components[1], maxTokensIn[0], maxTokensIn[1]);

        (uint256 amountAMin, uint256 amountBMin, uint256 liquidityExpectedFromSuppliedTokens) = arrakisVaultPool.getMintAmounts(maxTokensInA, maxTokensInB);
        
        require(
            minLiquidity <= liquidityExpectedFromSuppliedTokens,
            "_minLiquidity is too high for input token limit"
        );

        target = router;
        value = 0;
        data = abi.encodeWithSignature( 
            ADD_LIQUIDITY,
            arrakisVaultPool,
            maxTokensInA,
            maxTokensInB,
            amountAMin,
            amountBMin,
            setToken
        );
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
        revert("Arrakis single asset addition is not supported");
    }

    /**
     * Return calldata for the remove liquidity call
     *
     * @param  _setToken                Address of the SetToken
     * @param  _pool                    Address of liquidity token
     * @param  _components              Token address array required to remove liquidity
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
        address setToken = _setToken;
        address[] memory components = _components;
        uint256[] memory minTokensOut = _minTokensOut;
        uint256 liquidity = _liquidity;
        IArrakisVaultV1 arrakisVaultPool = IArrakisVaultV1(_pool);

        // Make sure that only up to the amount of liquidity tokens owned by the Set Token are redeemed
        uint256 setTokenLiquidityBalance = arrakisVaultPool.balanceOf(setToken);
        require(liquidity <= setTokenLiquidityBalance, "_liquidity must be <= to current balance");

        // Checks for minTokensOut
        require(minTokensOut[0] > 0 && minTokensOut[1] > 0, "Minimum quantity must be nonzero");

        // Sort the amount in order of tokens stored in Arrakis Pool
        (uint256 minTokensOutA, uint256 minTokensOutB) = _getOrderedAmount(components[0], components[1], minTokensOut[0], minTokensOut[1]);

        target = router;
        value = 0;
        data = abi.encodeWithSignature(
            REMOVE_LIQUIDITY,
            arrakisVaultPool,
            liquidity,
            minTokensOutA,
            minTokensOutB,
            setToken
        );
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
        revert("Arrakis single asset removal is not supported");
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
        spender = router;
    }

    /**
     * Verifies that this is an Arrakis Vault pool holding valid UniswapV3 position
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
        // Attempt to get the tokens of the provided pool
        address token0;
        address token1;
        try IArrakisVaultV1(_pool).token0() returns (IERC20 _token0) {
            token0 = address(_token0);
        } catch {
            return false;
        }
        try IArrakisVaultV1(_pool).token1() returns (IERC20 _token1) {
            token1 = address(_token1);
        } catch {
            return false;
        }

        // Make sure that components length is two
        if (_components.length != 2) {
            return false;
        }

        // Make sure that _components[0] is either of token0 or token1
        if (!(_components[0] == token0 || _components[0] == token1) ) {
            return false;
        }

        // Make sure that _components[1] is either of token0 or token1
        if (!(_components[1] == token0 || _components[1] == token1) ) {
            return false;
        }

        // Make sure the pool address follows IERC20 interface
        try IArrakisVaultV1(_pool).totalSupply() returns (uint256) {
        } catch {
            return false;
        }
        
        return true;
    }

    /**
     * Sorts the amount in order of tokens stored in Arrakis/UniswapV3 Pool
     *
     * @param  _token0        Address of token0
     * @param  _token1        Address of token1
     * @param  _amount0       Amount of token0
     * @param  _amount1       Amount of token1
     */
    function _getOrderedAmount(address _token0, address _token1, uint256 _amount0, uint256 _amount1) private pure returns(uint256, uint256) {
        return _token0 < _token1 ? (_amount0, _amount1) : (_amount1, _amount0);
    }
}