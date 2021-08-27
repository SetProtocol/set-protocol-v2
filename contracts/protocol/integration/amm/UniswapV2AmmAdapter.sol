/*
    Copyright 2020 Set Labs Inc.

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

import "../../../interfaces/external/IUniswapV2Router.sol";
import "../../../interfaces/external/IUniswapV2Pair.sol";
import "../../../interfaces/external/IUniswapV2Factory.sol";
import "../../../interfaces/IAmmAdapter.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";

struct Position {
  address setToken;
  address tokenA;
  uint256 amountA;
  address tokenB;
  uint256 amountB;
  uint256 balance;
  uint256 totalSupply;
  uint256 reserveA;
  uint256 reserveB;
  uint256 calculatedAmountA;
  uint256 calculatedAmountB;
}

/**
 * @title UniswapV2AmmAdapter
 * @author Stephen Hankinson
 *
 * Adapter for Uniswap V2 Router that encodes adding and removing liquidty
 */
contract UniswapV2AmmAdapter is IAmmAdapter {
    using SafeMath for uint256;

    /* ============ State Variables ============ */

    // Address of Uniswap V2 Router contract
    address public immutable router;
    IUniswapV2Factory public immutable factory;

    // Internal function string for adding liquidity
    string internal constant ADD_LIQUIDITY =
        "addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)";
    // Internal function string for removing liquidity
    string internal constant REMOVE_LIQUIDITY =
        "removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)";

    /* ============ Constructor ============ */

    /**
     * Set state variables
     *
     * @param _router          Address of Uniswap V2 Router contract
     */
    constructor(address _router) public {
        router = _router;
        factory = IUniswapV2Factory(IUniswapV2Router(_router).factory());
    }

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
        IUniswapV2Pair pair = IUniswapV2Pair(_pool);
        require(factory == IUniswapV2Factory(pair.factory()), "_pool factory doesn't match the router factory");
        require(_components.length == 2, "_components length is invalid");
        require(_maxTokensIn.length == 2, "_maxTokensIn length is invalid");
        require(factory.getPair(_components[0], _components[1]) == _pool,
            "_pool doesn't match the components");
        require(_maxTokensIn[0] > 0, "supplied token0 must be greater than 0");
        require(_maxTokensIn[1] > 0, "supplied token1 must be greater than 0");
        require(_minLiquidity > 0, "_minLiquidity must be greater than 0");

        Position memory position = Position(_setToken, _components[0], _maxTokensIn[0], _components[1], _maxTokensIn[1],
            0, pair.totalSupply(), 0, 0, 0, 0);
        require(position.totalSupply > 0, "_pool totalSupply must be > 0");

        // Determine how much of each token the _minLiquidity would return
        (position.reserveA, position.reserveB) = _getReserves(pair, position.tokenA);
        position.calculatedAmountA = position.reserveA.mul(_minLiquidity).div(position.totalSupply);
        position.calculatedAmountB = position.reserveB.mul(_minLiquidity).div(position.totalSupply);

        require(position.calculatedAmountA  <= position.amountA && position.calculatedAmountB <= position.amountB,
            "_minLiquidity is too high for input token limit");

        target = router;
        value = 0;
        data = abi.encodeWithSignature(
            ADD_LIQUIDITY,
            position.tokenA,
            position.tokenB,
            position.amountA,
            position.amountB,
            position.calculatedAmountA,
            position.calculatedAmountB,
            position.setToken,
            block.timestamp // solhint-disable-line not-rely-on-time
        );
    }

    /**
     * Return calldata for the add liquidity call for a single asset
     */
    function getProvideLiquiditySingleAssetCalldata(
        address /* _setToken */,
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
        revert("Uniswap V2 single asset addition is not supported");
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
        IUniswapV2Pair pair = IUniswapV2Pair(_pool);
        require(factory == IUniswapV2Factory(pair.factory()), "_pool factory doesn't match the router factory");
        require(_components.length == 2, "_components length is invalid");
        require(_minTokensOut.length == 2, "_minTokensOut length is invalid");
        require(factory.getPair(_components[0], _components[1]) == _pool,
            "_pool doesn't match the components");
        require(_minTokensOut[0] > 0, "requested token0 must be greater than 0");
        require(_minTokensOut[1] > 0, "requested token1 must be greater than 0");
        require(_liquidity > 0, "_liquidity must be greater than 0");

        Position memory position = Position(_setToken, _components[0], _minTokensOut[0], _components[1], _minTokensOut[1],
            pair.balanceOf(_setToken), pair.totalSupply(), 0, 0, 0, 0);

        require(_liquidity <= position.balance, "_liquidity must be <= to current balance");

        // Calculate how many tokens are owned by the liquidity
        (position.reserveA, position.reserveB) = _getReserves(pair, position.tokenA);
        position.calculatedAmountA = position.reserveA.mul(position.balance).div(position.totalSupply);
        position.calculatedAmountB = position.reserveB.mul(position.balance).div(position.totalSupply);

        require(position.amountA <= position.calculatedAmountA && position.amountB <= position.calculatedAmountB,
            "amounts must be <= ownedTokens");

        target = router;
        value = 0;
        data = abi.encodeWithSignature(
            REMOVE_LIQUIDITY,
            position.tokenA,
            position.tokenB,
            _liquidity,
            position.amountA,
            position.amountB,
            position.setToken,
            block.timestamp // solhint-disable-line not-rely-on-time
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
        revert("Uniswap V2 single asset removal is not supported");
    }

    /**
     * Returns the address of the spender
     *
     * @param  _pool       Address of liquidity token
     */
    function getSpenderAddress(address _pool)
        external
        view
        override
        returns (address spender)
    {
        IUniswapV2Pair pair = IUniswapV2Pair(_pool);
        require(factory == IUniswapV2Factory(pair.factory()), "_pool factory doesn't match the router factory");

        spender = router;
    }

    /**
     * Verifies that this is a valid Uniswap V2 _pool
     *
     * @param  _pool       Address of liquidity token
     */
    function isValidPool(address _pool)
        external
        view
        override
        returns (bool isValid) {
        address token0;
        address token1;
        bool success = true;
        IUniswapV2Pair pair = IUniswapV2Pair(_pool);

        try pair.token0() returns (address _token0) {
            token0 = _token0;
        } catch {
            success = false;
        }

        try pair.token1() returns (address _token1) {
            token1 = _token1;
        } catch {
            success = false;
        }

        if( success ) {
            isValid = factory.getPair(token0, token1) == _pool;
        }
        else {
            return false;
        }
    }

    /* ============ Internal Functions =================== */

    /**
     * Returns the pair reserves in an expected order
     *
     * @param  pair                   The pair to get the reserves from
     * @param  tokenA                 Address of the token to swap
     */
    function _getReserves(
        IUniswapV2Pair pair,
        address tokenA
    )
        internal
        view
        returns (uint reserveA, uint reserveB)
    {
        address token0 = pair.token0();
        (uint reserve0, uint reserve1,) = pair.getReserves();
        (reserveA, reserveB) = tokenA == token0 ? (reserve0, reserve1) : (reserve1, reserve0);
    }

}