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

import "../../../interfaces/external/IUniswapV2Router.sol";
import "../../../interfaces/external/IUniswapV2Pair.sol";
import "../../../interfaces/external/IUniswapV2Factory.sol";
import "../../../interfaces/IAmmAdapter.sol";
import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";

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
        address setToken = _setToken;
        IUniswapV2Pair pair = IUniswapV2Pair(_pool);

        require(_maxTokensIn[0] > 0 && _maxTokensIn[1] > 0, "Component quantity must be nonzero");

        // We expect the totalSupply to be greater than 0 because the isValidPool would
        // have passed by this point, meaning a pool for these tokens exist, which also
        // means there is at least MINIMUM_LIQUIDITY liquidity tokens in the pool
        // https://github.com/Uniswap/uniswap-v2-core/blob/master/contracts/UniswapV2Pair.sol#L121
        require(pair.totalSupply() > 0, "_pool totalSupply must be nonzero");

        // As mentioned above, the totalSupply of the pool should be greater than 0, and if
        // this is the case, we know the liquidity returned from the pool is equal to the minimum
        // of the given supplied token multiplied by the totalSupply of liquidity tokens divided by
        // the pool reserves of that token.
        // https://github.com/Uniswap/uniswap-v2-core/blob/master/contracts/UniswapV2Pair.sol#L123
        uint[] memory reserves = new uint[](2);
        (reserves[0], reserves[1]) = _getReserves(pair, _components[0]);
        uint256 liquidityExpectedFromSuppliedTokens = Math.min(
            _maxTokensIn[0].mul(pair.totalSupply()).div(reserves[0]),
            _maxTokensIn[1].mul(pair.totalSupply()).div(reserves[1])
        );

        require(
            _minLiquidity <= liquidityExpectedFromSuppliedTokens,
            "_minLiquidity is too high for input token limit"
        );

        // Now that we know the minimum expected liquidity to receive for the amount of tokens
        // that are being supplied, we can reverse the above equations in the min function to
        // determine how much actual tokens are supplied to the pool, therefore setting our
        // amountAMin and amountBMin of the addLiquidity call to the expected amounts.
        uint[] memory minTokensIn = new uint[](2);
        minTokensIn[0] = liquidityExpectedFromSuppliedTokens.mul(reserves[0]).div(pair.totalSupply());
        minTokensIn[1] = liquidityExpectedFromSuppliedTokens.mul(reserves[1]).div(pair.totalSupply());

        target = router;
        value = 0;
        data = abi.encodeWithSignature(
            ADD_LIQUIDITY,
            _components[0],
            _components[1],
            _maxTokensIn[0],
            _maxTokensIn[1],
            minTokensIn[0],
            minTokensIn[1],
            setToken,
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
        address setToken = _setToken;
        IUniswapV2Pair pair = IUniswapV2Pair(_pool);

        // Make sure that only up the amount of liquidity tokens owned by the Set Token are redeemed
        uint256 setTokenLiquidityBalance = pair.balanceOf(setToken);
        require(_liquidity <= setTokenLiquidityBalance, "_liquidity must be <= to current balance");

        // For a given Uniswap V2 Liquidity Pool, an owner of a liquidity token is able to claim
        // a portion of the reserves of that pool based on the percentage of liquidity tokens that
        // they own in relation to the total supply of the liquidity tokens. So if a user owns 25%
        // of the pool tokens, they would in effect own 25% of both reserveA and reserveB contained
        // within the pool. Therefore, given the value of _liquidity we can calculate how much of the
        // reserves the caller is requesting and can then validate that the _minTokensOut values are
        // less than or equal to that amount. If not, they are requesting too much of the _components
        // relative to the amount of liquidty that they are redeeming.
        uint[] memory reserves = new uint[](2);
        uint[] memory reservesOwnedByLiquidity = new uint[](2);
        (reserves[0], reserves[1]) = _getReserves(pair, _components[0]);
        reservesOwnedByLiquidity[0] = reserves[0].mul(_liquidity).div(pair.totalSupply());
        reservesOwnedByLiquidity[1] = reserves[1].mul(_liquidity).div(pair.totalSupply());

        require(
            _minTokensOut[0] <= reservesOwnedByLiquidity[0] && _minTokensOut[1] <= reservesOwnedByLiquidity[1],
            "amounts must be <= ownedTokens"
        );

        target = router;
        value = 0;
        data = abi.encodeWithSignature(
            REMOVE_LIQUIDITY,
            _components[0],
            _components[1],
            _liquidity,
            _minTokensOut[0],
            _minTokensOut[1],
            setToken,
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
     * Verifies that this is a valid Uniswap V2 pool
     *
     * @param  _pool          Address of liquidity token
     * @param  _components    Address array of supplied/requested tokens
     */
    function isValidPool(address _pool, address[] memory _components)
        external
        view
        override
        returns (bool) {
        // Attempt to get the factory of the provided pool
        IUniswapV2Factory poolFactory;
        try IUniswapV2Pair(_pool).factory() returns (address _factory) {
            poolFactory = IUniswapV2Factory(_factory);
        } catch {
            return false;
        }

        // Make sure the pool factory is the expected value, that we have the
        // two required components, and that the pair address returned
        // by the factory matches the supplied _pool value
        if(
            factory != poolFactory ||
            _components.length != 2 ||
            factory.getPair(_components[0], _components[1]) != _pool
        ) {
            return false;
        }

        return true;
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