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
  address token0;
  uint256 amount0;
  address token1;
  uint256 amount1;
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

    // Address of Uniswap V2 Router02 contract
    address public immutable router;
    IUniswapV2Factory public immutable factory;

    // Uniswap router function string for adding liquidity
    string internal constant ADD_LIQUIDITY =
        "addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)";
    // Uniswap router function string for removing liquidity
    string internal constant REMOVE_LIQUIDITY =
        "removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)";

    /* ============ Constructor ============ */

    /**
     * Set state variables
     *
     * @param _router       Address of Uniswap V2 Router02 contract
     */
    constructor(address _router) public {
        router = _router;
        factory = IUniswapV2Factory(IUniswapV2Router(_router).factory());
    }

    /* ============ Internal Functions =================== */

    /**
     * Return tokens in sorted order
     *
     * @param  _token0                  Address of the first token
     * @param  _amount0                 Amount of the first token
     * @param  _token1                  Address of the first token
     * @param  _amount1                 Amount of the second token
     */
    function getPosition(
        address _token0,
        uint256 _amount0,
        address _token1,
        uint256 _amount1
    )
        internal
        pure
        returns (
            Position memory position
        ) 
    {
        position = _token0 < _token1 ? 
            Position(_token0, _amount0, _token1, _amount1) : Position(_token1, _amount1, _token0, _amount0);
    }

    /* ============ External Getter Functions ============ */

    /**
     * Return calldata for Uniswap V2 Router02
     *
     * @param  _pool                    Address of liquidity token
     * @param  _components              Address array required to add liquidity
     * @param  _maxTokensIn             AmountsIn desired to add liquidity
     * @param  _minLiquidity            Min liquidity amount to add
     */
    function getProvideLiquidityCalldata(
        address _pool,
        address[] calldata _components,
        uint256[] calldata _maxTokensIn,
        uint256 _minLiquidity
    )
        external
        view
        override
        returns (
            address _target,
            uint256 _value,
            bytes memory _calldata
        )
    {

        IUniswapV2Pair pair = IUniswapV2Pair(_pool);
        require(factory == IUniswapV2Factory(pair.factory()), "_pool factory doesn't match the router factory");
        require(_components.length == 2, "_components length is invalid");
        require(_maxTokensIn.length == 2, "_maxTokensIn length is invalid");

        Position memory position =
             getPosition(_components[0], _maxTokensIn[0], _components[1], _maxTokensIn[1]);

        require(factory.getPair(position.token0, position.token1) == _pool, "_pool doesn't match the components");
        require(position.amount0 > 0, "supplied token0 must be greater than 0");
        require(position.amount1 > 0, "supplied token1 must be greater than 0");

        uint256 lpTotalSupply = pair.totalSupply();
        require(lpTotalSupply >= 0, "_pool totalSupply must be > 0");

        (uint256 reserve0, uint256 reserve1, ) = pair.getReserves();
        uint256 amount0Min = reserve0.mul(_minLiquidity).div(lpTotalSupply);
        uint256 amount1Min = reserve1.mul(_minLiquidity).div(lpTotalSupply);

        require(amount0Min <= position.amount0, "_minLiquidity too high for amount0");
        require(amount1Min <= position.amount1, "_minLiquidity too high for amount1");

        _target = router;
        _value = 0;
        _calldata = abi.encodeWithSignature(
            ADD_LIQUIDITY,
            position.token0,
            position.token1,
            position.amount0,
            position.amount1,
            amount0Min,
            amount1Min,
            msg.sender,
            block.timestamp // solhint-disable-line not-rely-on-time
        );
    }

    function getProvideLiquiditySingleAssetCalldata(
        address,
        address,
        uint256,
        uint256
    )
        external
        view
        override
        returns (
            address,
            uint256,
            bytes memory
        )
    {
        revert("Single asset liquidity addition not supported");
    }

    /**
     * Return calldata for Uniswap V2 Router02
     *
     * @param  _pool                    Address of liquidity token
     * @param  _components              Address array required to add liquidity
     * @param  _minTokensOut            AmountsOut minimum to remove liquidity
     * @param  _liquidity               Liquidity amount to remove
     */
    function getRemoveLiquidityCalldata(
        address _pool,
        address[] calldata _components,
        uint256[] calldata _minTokensOut,
        uint256 _liquidity
    )
        external
        view
        override
        returns (
            address _target,
            uint256 _value,
            bytes memory _calldata
        )
    {
        IUniswapV2Pair pair = IUniswapV2Pair(_pool);
        require(factory == IUniswapV2Factory(pair.factory()), "_pool factory doesn't match the router factory");
        require(_components.length == 2, "_components length is invalid");
        require(_minTokensOut.length == 2, "_minTokensOut length is invalid");

        Position memory position =
             getPosition(_components[0], _minTokensOut[0], _components[1], _minTokensOut[1]);

        require(factory.getPair(position.token0, position.token1) == _pool, "_pool doesn't match the components");
        require(position.amount0 > 0, "requested token0 must be greater than 0");
        require(position.amount1 > 0, "requested token1 must be greater than 0");

        uint256 balance = pair.balanceOf(msg.sender);
        require(_liquidity <= balance, "_liquidity must be <= to current balance");

        uint256 totalSupply = pair.totalSupply();
        (uint256 reserve0, uint256 reserve1, ) = pair.getReserves();
        uint256 ownedToken0 = reserve0.mul(balance).div(totalSupply);
        uint256 ownedToken1 = reserve1.mul(balance).div(totalSupply);

        require(position.amount0 <= ownedToken0, "amount0 must be <= ownedToken0");
        require(position.amount1 <= ownedToken1, "amount1 must be <= ownedToken1");

        _target = router;
        _value = 0;
        _calldata = abi.encodeWithSignature(
            REMOVE_LIQUIDITY,
            position.token0,
            position.token1,
            _liquidity,
            position.amount0,
            position.amount1,
            msg.sender,
            block.timestamp // solhint-disable-line not-rely-on-time
        );
    }

    function getRemoveLiquiditySingleAssetCalldata(
        address,
        address,
        uint256,
        uint256
    )
        external
        view
        override
        returns (
            address,
            uint256,
            bytes memory
        )
    {
        revert("Single asset liquidity removal not supported");
    }

    function getSpenderAddress(address _pool)
        external
        view
        override
        returns (address)
    {
        IUniswapV2Pair pair = IUniswapV2Pair(_pool);
        require(factory == IUniswapV2Factory(pair.factory()), "_pool factory doesn't match the router factory");

        return router;
    }

    function isValidPool(address _pool) external view override returns (bool) {
        address token0;
        address token1;
        IUniswapV2Pair pair = IUniswapV2Pair(_pool);
        try pair.token0() returns (address _token0) {
            token0 = _token0;
        } catch {
            return false;
        }
        try pair.token1() returns (address _token1) {
            token1 = _token1;
        } catch {
            return false;
        }
        return factory.getPair(token0, token1) == _pool;
    }
}