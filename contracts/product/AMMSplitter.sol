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
pragma experimental "ABIEncoderV2";

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { IUniswapV2Factory } from "../interfaces/external/IUniswapV2Factory.sol";
import { IUniswapV2Router } from "../interfaces/external/IUniswapV2Router.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";

/**
 * @title AMMSplitter
 * @author Set Protocol
 *
 * Peripheral contract which splits trades efficiently between Uniswap V2 and Sushiswap. Works for both exact input 
 * and exact output trades. All math for calculating the optimal split is performed on-chain. This contract only supports
 * trade paths of up to two hops.
 */
contract AMMSplitter {

    using SafeMath for uint256;
    using PreciseUnitMath for uint256;

    /* ============ Structs ============== */

    struct TradeInfo {
        uint256 uniSize;        // Uniswap trade size (can be either input or output depending on context)
        uint256 sushiSize;      // Sushiswap trade sze (can be either input or output depending on context)
    }

    /* ============ Constants ============ */

    // address of the Uniswap Router contract
    IUniswapV2Router public immutable uniRouter;
    // address of the Sushiswap Router contract
    IUniswapV2Router public immutable sushiRouter;
    // address of the Uniswap Factory contract
    IUniswapV2Factory public immutable uniFactory;
    // address of the Sushiswap Factory contract
    IUniswapV2Factory public immutable sushiFactory;

    /* =========== Constructor =========== */

    /**
     * Sets state variables
     *
     * @param _uniRouter    the Uniswap router contract
     * @param _sushiRouter  the Sushiswap router contract
     */
    constructor(IUniswapV2Router _uniRouter, IUniswapV2Router _sushiRouter) public {
        uniRouter = _uniRouter;
        sushiRouter = _sushiRouter;
        uniFactory = IUniswapV2Factory(_uniRouter.factory());
        sushiFactory = IUniswapV2Factory(_sushiRouter.factory());
    }

    /* ============ External Functions ============= */

    /**
     * Executes an exact input trade. Splits trade efficiently between Uniswap and Sushiswap
     *
     * @param _amountIn     the exact input amount
     * @param _amountOutMin the minimum output amount that must be received
     * @param _path         the path to use for the trade (length must be 3 or less)
     * @param _to           the address to direct the outputs to
     * @param _deadline     the deadline for the trade
     * 
     * @return totalOutput  the actual output amount
     */
    function swapExactTokensForTokens(
        uint256 _amountIn,
        uint256 _amountOutMin,
        address[] calldata _path,
        address _to,
        uint256 _deadline
    )
        external
        returns (uint256 totalOutput)
    {
        require(_path.length <= 3 && _path.length != 0, "TradeSplitter: incorrect path length");

        ERC20 inputToken = ERC20(_path[0]);
        inputToken.transferFrom(msg.sender, address(this), _amountIn);
        
        TradeInfo memory tradeInfo = _getTradeSizes(_path, _amountIn);

        _checkApprovals(tradeInfo.uniSize, tradeInfo.sushiSize, inputToken);

        uint256 uniOutput = _executeTrade(uniRouter, tradeInfo.uniSize, _path, _to, _deadline, true);
        uint256 sushiOutput = _executeTrade(sushiRouter, tradeInfo.sushiSize, _path, _to, _deadline, true);

        totalOutput = uniOutput.add(sushiOutput);
        require(totalOutput >= _amountOutMin, "TradeSplitter: INSUFFICIENT_OUTPUT_AMOUNT");
    }

    /**
     * Executes an exact output trade. Splits trade efficiently between Uniswap and Sushiswap
     *
     * @param _amountOut    the exact output amount
     * @param _amountInMax  the maximum input amount that can be spent
     * @param _path         the path to use for the trade (length must be 3 or less)
     * @param _to           the address to direct the outputs to
     * @param _deadline     the deadline for the trade
     * 
     * @return totalInput   the actual input amount
     */
    function swapTokensForExactTokens(
        uint256 _amountOut,
        uint256 _amountInMax,
        address[] calldata _path,
        address _to,
        uint256 _deadline
    )
        external
        returns (uint256 totalInput)
    {
        require(_path.length <= 3 && _path.length != 0, "TradeSplitter: incorrect path length");

        TradeInfo memory tradeInfo = _getTradeSizes(_path, _amountOut);

        uint256 expectedUniInput = _getTradeInputOrOutput(uniRouter, tradeInfo.uniSize, _path, false)[0];
        uint256 expectedSushiInput = _getTradeInputOrOutput(sushiRouter, tradeInfo.sushiSize, _path, false)[0];

        totalInput = expectedUniInput.add(expectedSushiInput);
        require(totalInput <= _amountInMax, "TradeSplitter: INSUFFICIENT_INPUT_AMOUNT");

        ERC20 inputToken = ERC20(_path[0]);
        inputToken.transferFrom(msg.sender, address(this), expectedUniInput.add(expectedSushiInput));

        _checkApprovals(expectedUniInput, expectedSushiInput, inputToken);

        _executeTrade(uniRouter, tradeInfo.uniSize, _path, _to, _deadline, false);
        _executeTrade(sushiRouter, tradeInfo.sushiSize, _path, _to, _deadline, false);
    }

    /* =========== External Getter Functions =========== */

    /**
     * Returns a quote with an estimated trade output amount
     *
     * @param _amountIn     input amount
     * @param _path         the trade path to use
     *
     * @return uint256[]    array of input amounts, intermiary amounts, and output amounts
     */
    function getAmountsOut(uint256 _amountIn, address[] calldata _path) external  view returns (uint256[] memory) {
        return _getAmounts(_amountIn, _path, true);
    }

    /**
     * Returns a quote with an estimated trade output amount
     *
     * @param _amountOut    output amount
     * @param _path         the trade path to use
     *
     * @return uint256[]    array of input amounts, intermediary amounts, and output amounts
     */
    function getAmountsIn(uint256 _amountOut, address[] calldata _path) external  view returns (uint256[] memory) {
        return _getAmounts(_amountOut, _path, false);
    }

    /* ============= Internal Functions ============ */

    /**
     * Helper function for getting trade quotes
     *
     * @param _size             input or output amount depending on _isExactInput
     * @param _path             trade path to use
     * @param _isExactInput     whether an exact input or an exact output trade quote is needed
     *
     * @return amounts          array of input amounts, intermediary amounts, and output amounts
     */
    function _getAmounts(uint256 _size, address[] calldata _path, bool _isExactInput) internal view returns (uint256[] memory amounts) {

        require(_path.length <= 3 && _path.length != 0, "TradeSplitter: incorrect path length");

        TradeInfo memory tradeInfo = _getTradeSizes(_path, _size);

        uint256[] memory uniTradeResults = _getTradeInputOrOutput(uniRouter, tradeInfo.uniSize, _path, _isExactInput);
        uint256[] memory sushiTradeResults = _getTradeInputOrOutput(sushiRouter, tradeInfo.sushiSize, _path, _isExactInput);

        amounts = new uint256[](_path.length);
        for (uint256 i = 0; i < amounts.length; i++) {
            amounts[i] = uniTradeResults[i].add(sushiTradeResults[i]);
        }
    }

    /**
     * Calculates the optimal trade sizes for Uniswap and Sushiswap.
     *
     * @param _path         the trade path that will be used
     * @param _size         the total size of the trade
     *
     * @return TradeInfo    TradeInfo struct containing Uniswap and Sushiswap tarde sizes
     */
    function _getTradeSizes(address[] calldata _path, uint256 _size) internal view returns (TradeInfo memory) {

        uint256 uniPercentage;
        if (_path.length == 2) {

            address uniPair = uniFactory.getPair(_path[0], _path[1]);
            uint256 uniValue = ERC20(_path[0]).balanceOf(uniPair);

            address sushiPair = sushiFactory.getPair(_path[0], _path[1]);
            uint256 sushiValue = ERC20(_path[0]).balanceOf(sushiPair);

            uniPercentage = uniValue.preciseDiv(uniValue.add(sushiValue));
        } else {
            address uniPairA = uniFactory.getPair(_path[0], _path[1]);
            address uniPairB = uniFactory.getPair(_path[1], _path[2]);

            uint256 uniValueA = ERC20(_path[1]).balanceOf(uniPairA);
            uint256 uniValueB = ERC20(_path[1]).balanceOf(uniPairB);

            if(uniValueA == 0 || uniValueB == 0) return TradeInfo(0, _size);

            address sushiPairA = sushiFactory.getPair(_path[0], _path[1]);
            address sushiPairB = sushiFactory.getPair(_path[1], _path[2]);

            uint256 sushiValueA = ERC20(_path[1]).balanceOf(sushiPairA);
            uint256 sushiValueB = ERC20(_path[1]).balanceOf(sushiPairB);

            if(sushiValueA == 0 || sushiValueB == 0) return TradeInfo(_size, 0);

            uint256 ratio = _calculateTwoHopRatio(uniValueA, uniValueB, sushiValueA, sushiValueB);
            uniPercentage = ratio.preciseDiv(ratio.add(PreciseUnitMath.PRECISE_UNIT));
        }

        TradeInfo memory tradeInfo;
        tradeInfo.uniSize = _size.preciseMul(uniPercentage);
        tradeInfo.sushiSize = _size.sub(tradeInfo.uniSize);

        return tradeInfo;
    }

    /**
     * Calculates the optimal ratio of Uniswap trade size to Sushiswap trade size. To calculate the ratio between Uniswap
     * and Sushiswap use: 
     *
     * Tu/Ts = ((Psa + Psb) * Pua * Pub) / ((Pua + Pub) * Psa * Psb)
     *
     * Ts  = Sushiswap trade size
     * Tu  = Uniswap trade size
     * Pua = Uniswap liquidity for pool A
     * Pub = Uniswap liquidity for pool B
     * Psa = Sushiswap liquidity for pool A
     * Psb = Sushiswap liquidity for pool B
     *
     * @param _uniValueA        Size of the first Uniswap pool
     * @param _uniValueB        Size of the second Uniswap pool
     * @param _sushiValueA      Size of the first Sushiswap pool
     * @param _sushiValueB      Size of the second Sushiswap pool
     *
     * @return uint256          the ratio of Uniswap trade size to Sushiswap trade size
     */
    function _calculateTwoHopRatio(
        uint256 _uniValueA,
        uint256 _uniValueB,
        uint256 _sushiValueA,
        uint256 _sushiValueB
    ) 
        internal
        pure
        returns (uint256)
    {
        uint256 a = _sushiValueA.add(_sushiValueB).preciseMul(_uniValueA).preciseMul(_uniValueB);
        uint256 b = _uniValueA.add(_uniValueB).preciseMul(_sushiValueA).preciseMul(_sushiValueB);
        return a.preciseDiv(b);
    }

    /**
     * Checks the token approvals to the Uniswap and Sushiswap routers are sufficient. If not
     * it bumps the allowance to MAX_UINT_256.
     *
     * @param _uniAmount    Uniswap input amount
     * @param _sushiAmount  Sushiswap input amount
     * @param _token        Token being traded
     */
    function _checkApprovals(uint256 _uniAmount, uint256 _sushiAmount, ERC20 _token) internal {
        if (_token.allowance(address(this), address(uniRouter)) < _uniAmount) {
            _token.approve(address(uniRouter), PreciseUnitMath.MAX_UINT_256);
        }
        if (_token.allowance(address(this), address(sushiRouter)) < _sushiAmount) {
            _token.approve(address(sushiRouter), PreciseUnitMath.MAX_UINT_256);
        }
    }

    /**
     * Executes a trade on Uniswap or Sushiswap. If passed a trade size of 0, skip the
     * trade.
     *
     * @param _router           The router to execute the trade through (either Uniswap or Sushiswap)
     * @param _size             Input amount if _isExactInput is true, output amount if false
     * @param _path             Path for the trade
     * @param _to               Address to redirect trade output to
     * @param _deadline         Timestamp that trade must execute before
     * @param _isExactInput     Whether to perfrom an exact input or exact output swap
     *
     * @return uint256          the actual input / output amount of the trade
     */
    function _executeTrade(
        IUniswapV2Router _router,
        uint256 _size,
        address[] calldata _path,
        address _to,
        uint256 _deadline,
        bool _isExactInput
    ) 
        internal
        returns (uint256)
    {
        if (_size == 0) return 0;

        if (_isExactInput) {
            return _router.swapExactTokensForTokens(_size, 0, _path, _to, _deadline)[_path.length.sub(1)];
        } else {
            return _router.swapTokensForExactTokens(_size, uint256(-1), _path, _to, _deadline)[_path.length.sub(1)];
        }
    }

    /**
     * Gets a trade quote on Uniswap or Sushiswap
     *
     * @param _router           The router to get the quote from (either Uniswap or Sushiswap)
     * @param _size             Input amount if _isExactInput is true, output amount if false
     * @param _path             Path for the trade
     * @param _isExactInput     Whether to get a getAmountsIn or getAmountsOut quote
     *
     * @return uint256[]        Array of input amounts, intermediary amounts, and output amounts
     */
    function _getTradeInputOrOutput(
        IUniswapV2Router _router,
        uint256 _size,
        address[] calldata _path,
        bool _isExactInput
    )
        internal
        view
        returns (uint256[] memory)
    {
        if (_size == 0) return new uint256[](_path.length);     // zero array

        if(_isExactInput) {
            return _router.getAmountsOut(_size, _path);
        } else {
            return _router.getAmountsIn(_size, _path);
        }
    }
}
