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
pragma experimental "ABIEncoderV2";

import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import "../../../interfaces/IAmmAdapter.sol";
import "../../../interfaces/external/curve/ICurveMinter.sol";
import "../../../interfaces/external/curve/ICurveV1.sol";
import "../../../interfaces/external/curve/ICurveV2.sol";

/**
 * @title CurveAmmAdapter
 * @author deephil
 *
 * Adapter for Curve that encodes functions for adding and removing liquidity
 */
contract CurveAmmAdapter is IAmmAdapter {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    /* ============ State Variables ============ */

    // Internal function string for add liquidity
    string internal constant ADD_LIQUIDITY = "addLiquidity(address,uint256[],uint256,address)";
    
    // Internal function string for remove liquidity
    string internal constant REMOVE_LIQUIDITY = "removeLiquidity(address,uint256,uint256[],address)";

    // Internal function string for remove liquidity one coin
    string internal constant REMOVE_LIQUIDITY_ONE_COIN = "removeLiquidityOneCoin(address,uint256,uint256,uint256,address)";

    // Address of Curve Pool token contract (IERC20 interface)
    address public immutable poolToken;

    // Address of Curve Pool minter contract
    address public immutable poolMinter;

    // If Curve v1 or Curve v2.
    // Curve v1 use `int128` for coin indexes, Curve v2 use `uint256` for coin indexes
    bool public immutable isCurveV1;

    // Coin count of Curve Pool
    uint256 public immutable coinCount;

    // Coin addresses of Curve Pool
    address[] public coins;

    // Coin Index of Curve Pool (starts from 1)
    mapping(address => uint256) public coinIndex;

    /* ============ Constructor ============ */

    /**
     * Set state variables
     *
     * @param _poolToken          Address of Curve Pool token
     * @param _poolMinter         Address of Curve Pool token minter
     * @param _isCurveV1          curve v1 or v2
     * @param _coinCount          Number of coins in Curve Pool token
     */
    constructor(
        address _poolToken,
        address _poolMinter,
        bool _isCurveV1,
        uint256 _coinCount
    ) public {
        require(_poolToken != address(0), "_poolToken can't be zero address");
        require(_poolMinter != address(0), "_poolMinter can't be zero address");
        require(_coinCount >= 2 && _coinCount <= 4, "invalid coin count");

        poolToken = _poolToken;
        poolMinter = _poolMinter;
        isCurveV1 = _isCurveV1;
        coinCount = _coinCount;
        for (uint256 i = 0 ; i < _coinCount ; ++i) {
            address coin = ICurveMinter(_poolMinter).coins(i);
            coins.push(coin);
            coinIndex[coin] = i.add(1);

            IERC20(coin).safeApprove(address(_poolMinter), type(uint256).max);
        }
    }

    function addLiquidity(
        address _pool,
        uint256[] memory _amountsIn,
        uint256 _minLiquidity,
        address _destination
    ) external {
        require(poolToken == _pool, "invalid pool address");
        require(coinCount == _amountsIn.length, "invalid amounts in");
        require(_minLiquidity != 0, "invalid min liquidity");
        require(_destination != address(0), "invalid destination");

        bool isValidAmountsIn = false;
        for (uint256 i = 0; i < coinCount; ++i) {
            if (_amountsIn[i] > 0) {
                isValidAmountsIn = true;
            }
        }
        require(isValidAmountsIn, "invalid amounts in");

        for (uint256 i = 0; i < coinCount; ++i) {
            IERC20(coins[i]).safeTransferFrom(msg.sender, address(this), _amountsIn[i]);
        }

        if (coinCount == 2) {
            ICurveMinter(poolMinter).add_liquidity([_amountsIn[0], _amountsIn[1]], _minLiquidity);
        }
        else if (coinCount == 3) {
            ICurveMinter(poolMinter).add_liquidity([_amountsIn[0], _amountsIn[1], _amountsIn[2]], _minLiquidity);
        }
        else if (coinCount == 4) {
            ICurveMinter(poolMinter).add_liquidity([_amountsIn[0], _amountsIn[1], _amountsIn[2], _amountsIn[3]], _minLiquidity);
        } else {
            revert("curve supports 2/3/4 coins");
        }

        _transferToken(_pool, _destination);
    }

    function removeLiquidity(
        address _pool,
        uint256 _liquidity,
        uint256[] memory _minAmountsOut,
        address _destination
    ) external {
        require(poolToken == _pool, "invalid pool address");
        require(_liquidity != 0, "invalid liquidity");
        require(coinCount == _minAmountsOut.length, "invalid amounts out");
        require(_destination != address(0), "invalid destination");

        IERC20(_pool).safeTransferFrom(msg.sender, address(this), _liquidity);

        if (coinCount == 2) {
            ICurveMinter(poolMinter).remove_liquidity(_liquidity, [_minAmountsOut[0], _minAmountsOut[1]]);
        }
        else if (coinCount == 3) {
            ICurveMinter(poolMinter).remove_liquidity(_liquidity, [_minAmountsOut[0], _minAmountsOut[1], _minAmountsOut[2]]);
        }
        else if (coinCount == 4) {
            ICurveMinter(poolMinter).remove_liquidity(_liquidity, [_minAmountsOut[0], _minAmountsOut[1], _minAmountsOut[2], _minAmountsOut[3]]);
        } else {
            revert("curve supports 2/3/4 coins");
        }

        for (uint256 i = 0; i < coinCount; ++i) {
            _transferToken(coins[i], _destination);
        }
    }

    function removeLiquidityOneCoin(
        address _pool,
        uint256 _liquidity,
        uint256 _coinIndex,
        uint256 _minTokenout,
        address _destination
    ) external {
        require(poolToken == _pool, "invalid pool address");
        require(_liquidity != 0, "invalid liquidity");
        require(_coinIndex < coinCount, "invalid coin index");
        require(_minTokenout != 0, "invalid min token out");
        require(_destination != address(0), "invalid destination");

        IERC20(_pool).safeTransferFrom(msg.sender, address(this), _liquidity);

        if (isCurveV1) {
            ICurveV1(poolMinter).remove_liquidity_one_coin(_liquidity, int128(int256(_coinIndex)), _minTokenout);
        } else {
            ICurveV2(poolMinter).remove_liquidity_one_coin(_liquidity, _coinIndex, _minTokenout);
        }

        _transferToken(coins[_coinIndex], _destination);
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
        address[] memory components = _components;
        uint256[] memory maxTokensIn = _maxTokensIn;
        require(isValidPool(_pool, components), "invalid pool address");
        require(components.length == maxTokensIn.length, "invalid amounts");

        target = address(this);
        value = 0;
        data = abi.encodeWithSignature(
            ADD_LIQUIDITY,
            _pool,
            maxTokensIn,
            _minLiquidity,
            _setToken
        );
    }

    /**
     * Return calldata for the add liquidity call for a single asset
     */
    function getProvideLiquiditySingleAssetCalldata(
        address _setToken,
        address _pool,
        address _component,
        uint256 _maxTokenIn,
        uint256 _minLiquidity
    )
        external
        view
        override
        returns (address target, uint256 value, bytes memory data)
    {
        require(poolToken == _pool, "invalid pool address");
        require(coinIndex[_component] > 0, "invalid component token");
        require(_maxTokenIn != 0, "invalid component amount");
        
        uint256[] memory amountsIn = new uint256[](coinCount);
        amountsIn[coinIndex[_component].sub(1)] = _maxTokenIn;

        target = address(this);
        value = 0;
        data = abi.encodeWithSignature(
            ADD_LIQUIDITY,
            _pool,
            amountsIn,
            _minLiquidity,
            _setToken
        );
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
        address[] memory components = _components;
        uint256[] memory minTokensOut = _minTokensOut;
        require(isValidPool(_pool, components), "invalid pool address");
        require(components.length == minTokensOut.length, "invalid amounts");

        {
            // Check liquidity parameter
            uint256 setTokenLiquidityBalance = IERC20(_pool).balanceOf(_setToken);
            require(_liquidity <= setTokenLiquidityBalance, "_liquidity must be <= to current balance");
        }

        {
            // Check minTokensOut parameter
            uint256 totalSupply = IERC20(_pool).totalSupply();
            uint256[] memory reserves = _getReserves();
            for (uint256 i = 0; i < coinCount; ++i) {
                uint256 reservesOwnedByLiquidity = reserves[i].mul(_liquidity).div(totalSupply);
                require(minTokensOut[i] <= reservesOwnedByLiquidity, "amounts must be <= ownedTokens");
            }
        }

        target = address(this);
        value = 0;
        data = abi.encodeWithSignature(
            REMOVE_LIQUIDITY,
            _pool,
            _liquidity,
            minTokensOut,
            _setToken
        );
    }

    /**
     * Return calldata for the remove liquidity single asset call
     */
    function getRemoveLiquiditySingleAssetCalldata(
        address _setToken,
        address _pool,
        address _component,
        uint256 _minTokenOut,
        uint256 _liquidity
    )
        external
        view
        override
        returns (address target, uint256 value, bytes memory data)
    {
        require(poolToken == _pool, "invalid pool address");
        require(coinIndex[_component] > 0, "invalid component token");

        {
            // Check liquidity parameter
            uint256 setTokenLiquidityBalance = IERC20(_pool).balanceOf(_setToken);
            require(_liquidity <= setTokenLiquidityBalance, "_liquidity must be <= to current balance");
        }
        
        target = address(this);
        value = 0;
        data = abi.encodeWithSignature(
            REMOVE_LIQUIDITY_ONE_COIN,
            _pool,
            _liquidity,
            coinIndex[_component].sub(1),
            _minTokenOut,
            _setToken
        );
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
        spender = address(this);
    }

    /**
     * Verifies that this is a valid curve pool
     *
     * @param  _pool          Address of liquidity token
     * @param  _components    Address array of supplied/requested tokens
     */
    function isValidPool(address _pool, address[] memory _components)
        public
        view
        override
        returns (bool) {
        if (poolToken != _pool) {
            return false;
        }

        if (_components.length == 1) {
            if (coinIndex[_components[0]] == 0) {
                return false;
            }
        } else {
            if (coinCount != _components.length) {
                return false;
            }
            for (uint256 i = 0; i < coinCount; ++i) {
                if (coins[i] != _components[i]) {
                    return false;
                }
            }
        }

        return true;
    }

    /* ============ Internal Functions =================== */

    /**
     * Returns the Curve Pool token reserves in an expected order
     */
    function _getReserves()
        internal
        view
        returns (uint256[] memory reserves)
    {
        reserves = new uint256[](coinCount);

        for (uint256 i = 0; i < coinCount; ++i) {
            reserves[i] = ICurveMinter(poolMinter).balances(i);
        }
    }

    /**
     * Transfer tokens to recipient address
     *
     * @param  token        Address of token
     * @param  recipient    Address of recipient
     */
    function _transferToken(
        address token,
        address recipient
    ) internal {
        IERC20(token).safeTransfer(recipient, IERC20(token).balanceOf(address(this)));
    }
}