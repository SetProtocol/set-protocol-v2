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
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

struct Position {
  IERC20 token0;
  uint256 amount0;
  IERC20 token1;
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

    // Address of Uniswap V2 Router contract
    IUniswapV2Router public immutable router;
    IUniswapV2Factory public immutable factory;

    // Uniswap router function string for adding liquidity
    string internal constant ADD_LIQUIDITY =
        "addLiquidity(address,address[],uint256[],uint256)";
    // Uniswap router function string for removing liquidity
    string internal constant REMOVE_LIQUIDITY =
        "removeLiquidity(address,address[],uint256[],uint256)";

    /* ============ Constructor ============ */

    /**
     * Set state variables
     *
     * @param _router       Address of Uniswap V2 Router contract
     */
    constructor(address _router) public {
        router = IUniswapV2Router(_router);
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
        IUniswapV2Pair _pair,
        address _token0,
        uint256 _amount0,
        address _token1,
        uint256 _amount1
    )
        internal
        view
        returns (
            Position memory position
        ) 
    {
        position = _pair.token0() == _token0 ? 
            Position(IERC20(_token0), _amount0, IERC20(_token1), _amount1) : 
                Position(IERC20(_token1), _amount1, IERC20(_token0), _amount0);
    }

    /* ============ External Getter Functions ============ */

    /**
     * Return calldata for the add liquidity call
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
        _target = address(this);
        _value = 0;
        _calldata = abi.encodeWithSignature(
            ADD_LIQUIDITY,
            _pool,
            _components,
            _maxTokensIn,
            _minLiquidity
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
     * Return calldata for the remove liquidity call
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
        _target = address(this);
        _value = 0;
        _calldata = abi.encodeWithSignature(
            REMOVE_LIQUIDITY,
            _pool,
            _components,
            _minTokensOut,
            _liquidity
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

        return address(this);
    }

    function isValidPool(address _pool) external view override returns (bool) {
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
            return factory.getPair(token0, token1) == _pool;
        }
        else {
            return false;
        }
    }

    /* ============ External Setter Functions ============ */

    /**
     * Adds liquidity via the Uniswap V2 Router
     *
     * @param  _pool                    Address of liquidity token
     * @param  _components              Address array required to add liquidity
     * @param  _maxTokensIn             AmountsIn desired to add liquidity
     * @param  _minLiquidity            Min liquidity amount to add
     */
    function addLiquidity(
        address _pool,
        address[] calldata _components,
        uint256[] calldata _maxTokensIn,
        uint256 _minLiquidity
    )
        external
        returns (
            uint amountA,
            uint amountB,
            uint liquidity
        )
    {

        IUniswapV2Pair pair = IUniswapV2Pair(_pool);
        require(factory == IUniswapV2Factory(pair.factory()), "_pool factory doesn't match the router factory");
        require(_components.length == 2, "_components length is invalid");
        require(_maxTokensIn.length == 2, "_maxTokensIn length is invalid");
        require(factory.getPair(_components[0], _components[1]) == _pool, 
            "_pool doesn't match the components");
        require(_maxTokensIn[0] > 0, "supplied token0 must be greater than 0");
        require(_maxTokensIn[1] > 0, "supplied token1 must be greater than 0");

        Position memory position =
             getPosition(pair, _components[0], _maxTokensIn[0], _components[1], _maxTokensIn[1]);

        uint256 lpTotalSupply = pair.totalSupply();
        require(lpTotalSupply >= 0, "_pool totalSupply must be > 0");

        (uint256 reserve0, uint256 reserve1, ) = pair.getReserves();
        uint256 amount0Min = reserve0.mul(_minLiquidity).div(lpTotalSupply);
        uint256 amount1Min = reserve1.mul(_minLiquidity).div(lpTotalSupply);

        require(amount0Min <= position.amount0 && amount1Min <= position.amount1, 
            "_minLiquidity is too high for amount minimums");

        // Bring the tokens to this contract so we can use the Uniswap Router
        position.token0.transferFrom(msg.sender, address(this), position.amount0);
        position.token1.transferFrom(msg.sender, address(this), position.amount1);

        // Approve the router to spend the tokens
        position.token0.approve(address(router), position.amount0);
        position.token1.approve(address(router), position.amount1);

        // Add the liquidity
        (amountA, amountB, liquidity) = router.addLiquidity(
            address(position.token0),
            address(position.token1),
            position.amount0,
            position.amount1,
            amount0Min,
            amount1Min,
            msg.sender,
            block.timestamp // solhint-disable-line not-rely-on-time
        );

        // If there is token0 left, send it back
        if( amountA < position.amount0 ) {
            position.token0.transfer(msg.sender, position.amount0.sub(amountA) );
        }

        // If there is token1 left, send it back
        if( amountB < position.amount1 ) {
            position.token1.transfer(msg.sender, position.amount1.sub(amountB) );
        }

    }

    /**
     * Remove liquidity via the Uniswap V2 Router
     *
     * @param  _pool                    Address of liquidity token
     * @param  _components              Address array required to add liquidity
     * @param  _minTokensOut            AmountsOut minimum to remove liquidity
     * @param  _liquidity               Liquidity amount to remove
     */
    function removeLiquidity(
        address _pool,
        address[] calldata _components,
        uint256[] calldata _minTokensOut,
        uint256 _liquidity
    )
        external
        returns (
            uint amountA,
            uint amountB
        )
    {
        IUniswapV2Pair pair = IUniswapV2Pair(_pool);
        require(factory == IUniswapV2Factory(pair.factory()), "_pool factory doesn't match the router factory");
        require(_components.length == 2, "_components length is invalid");
        require(_minTokensOut.length == 2, "_minTokensOut length is invalid");
        require(factory.getPair(_components[0], _components[1]) == _pool, 
            "_pool doesn't match the components");
        require(_minTokensOut[0] > 0, "requested token0 must be greater than 0");
        require(_minTokensOut[1] > 0, "requested token1 must be greater than 0");

        Position memory position =
             getPosition(pair, _components[0], _minTokensOut[0], _components[1], _minTokensOut[1]);

        uint256 balance = pair.balanceOf(msg.sender);
        require(_liquidity <= balance, "_liquidity must be <= to current balance");

        uint256 totalSupply = pair.totalSupply();
        (uint256 reserve0, uint256 reserve1, ) = pair.getReserves();
        uint256 ownedToken0 = reserve0.mul(balance).div(totalSupply);
        uint256 ownedToken1 = reserve1.mul(balance).div(totalSupply);

        require(position.amount0 <= ownedToken0 && position.amount1 <= ownedToken1, 
            "amounts must be <= ownedTokens");   

        // Bring the lp token to this contract so we can use the Uniswap Router
        pair.transferFrom(msg.sender, address(this), _liquidity);

        // Approve the router to spend the lp tokens
        pair.approve(address(router), _liquidity);

        // Remove the liquidity
        (amountA, amountB) = router.removeLiquidity(
            address(position.token0), 
            address(position.token1), 
            _liquidity, 
            position.amount0, 
            position.amount1, 
            msg.sender, 
            block.timestamp // solhint-disable-line not-rely-on-time
        );
    }
}