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

import { IUniswapV2Factory } from "../../../interfaces/external/IUniswapV2Factory.sol";
import { IUniswapV2Router } from "../../../interfaces/external/IUniswapV2Router.sol";
import { PreciseUnitMath } from "../../../lib/PreciseUnitMath.sol";

import { console } from "hardhat/console.sol";


contract TradeSplitter {

    using SafeMath for uint256;
    using PreciseUnitMath for uint256;

    IUniswapV2Router public immutable uniRouter;
    IUniswapV2Router public immutable sushiRouter;
    IUniswapV2Factory public immutable uniFactory;
    IUniswapV2Factory public immutable sushiFactory;

    constructor(IUniswapV2Router _uniRouter, IUniswapV2Router _sushiRouter) public {
        uniRouter = _uniRouter;
        sushiRouter = _sushiRouter;
        uniFactory = IUniswapV2Factory(_uniRouter.factory());
        sushiFactory = IUniswapV2Factory(_sushiRouter.factory());
    }

    function tradeExactInput(
        uint256 _amountIn,
        uint256 _amountOutMin,
        address[] calldata _path,
        address _to,
        uint256 _deadline
    )
        external
        returns (uint256)
    {
        require(_path.length <= 3 && _path.length != 0, "UniswapV2LikeTradeSplitter: incorrect path length");

        ERC20 inputToken = ERC20(_path[0]);
        inputToken.transferFrom(msg.sender, address(this), _amountIn);

        uint256 uniSplit = _getUniSplit(_path);

        uint256 uniTradeSize = uniSplit.preciseMul(_amountIn);
        uint256 sushiTradeSize = _amountIn.sub(uniTradeSize);

        _checkApprovals(uniTradeSize, sushiTradeSize, inputToken);

        uint256 uniOutput = 0;
        uint256 sushiOutput = 0;

        if (uniTradeSize > 0) {
            uniOutput = uniRouter.swapExactTokensForTokens(uniTradeSize, 0, _path, _to, _deadline)[_path.length.sub(1)];
        }
        if (sushiTradeSize > 0) {
            sushiOutput = sushiRouter.swapExactTokensForTokens(sushiTradeSize, 0, _path, _to, _deadline)[_path.length.sub(1)];
        }

        uint256 totalOutput = uniOutput.add(sushiOutput);
        require(totalOutput > _amountOutMin, "UniswapV2LikeTradeSplitter: INSUFFICIENT_OUTPUT_AMOUNT");

        return totalOutput;
    }

    function tradeExactOutput(
        uint256 _amountInMax,
        uint256 _amountOut,
        address[] calldata _path,
        address _to,
        uint256 _deadline
    )
        external
        returns (uint256)
    {
        require(_path.length <= 3 && _path.length != 0, "UniswapV2LikeTradeSplitter: incorrect path length");

        uint256 uniSplit = _getUniSplit(_path);

        uint256 uniTradeSize = uniSplit.preciseMul(_amountOut);
        uint256 sushiTradeSize = _amountOut.sub(uniTradeSize);

        uint256 expectedUniInput = 0;
        uint256 expectedSushiInput = 0;

        if (uniSplit > 0) {
            expectedUniInput = uniRouter.getAmountsIn(uniTradeSize, _path)[0];
        }
        if (uniSplit < PreciseUnitMath.PRECISE_UNIT) {
            expectedSushiInput = sushiRouter.getAmountsIn(sushiTradeSize, _path)[0];
        }

        ERC20(_path[0]).transferFrom(msg.sender, address(this), expectedUniInput.add(expectedSushiInput));

        _checkApprovals(expectedUniInput, expectedSushiInput, ERC20(_path[0]));

        uint256 uniInput = 0;
        uint256 sushiInput = 0;

        if (uniTradeSize > 0) {
            uniInput = uniRouter.swapTokensForExactTokens(uniTradeSize, uint256(-1), _path, _to, _deadline)[_path.length.sub(1)];
        }
        if (sushiTradeSize > 0) {
            sushiInput = sushiRouter.swapTokensForExactTokens(sushiTradeSize, uint256(-1), _path, _to, _deadline)[_path.length.sub(1)];
        }

        uint256 totalInput = uniInput.add(sushiInput);
        require(totalInput < _amountInMax, "UniswapV2LikeTradeSplitter: INSUFFICIENT_INPUT_AMOUNT");

        return totalInput;
    }

    function _getUniSplit(address[] calldata _path) internal view returns (uint256) {
        if (_path.length == 2) {
            
            address uniPair = uniFactory.getPair(_path[0], _path[1]);
            uint256 uniValue = ERC20(_path[0]).balanceOf(uniPair);

            address sushiPair = sushiFactory.getPair(_path[0], _path[1]);
            uint256 sushiValue = ERC20(_path[0]).balanceOf(sushiPair);

            return uniValue.preciseDiv(uniValue.add(sushiValue));
        }

        if (_path.length == 3) {
            
            address uniPairA = uniFactory.getPair(_path[0], _path[1]);
            address uniPairB = uniFactory.getPair(_path[1], _path[2]);

            uint256 uniValueA = ERC20(_path[1]).balanceOf(uniPairA);
            uint256 uniValueB = ERC20(_path[1]).balanceOf(uniPairB);

            if(uniValueA == 0 || uniValueB == 0) return 0;

            address sushiPairA = sushiFactory.getPair(_path[0], _path[1]);
            address sushiPairB = sushiFactory.getPair(_path[1], _path[2]);

            uint256 sushiValueA = ERC20(_path[1]).balanceOf(sushiPairA);
            uint256 sushiValueB = ERC20(_path[1]).balanceOf(sushiPairB);

            if(sushiValueA == 0 || sushiValueB == 0) return PreciseUnitMath.PRECISE_UNIT;

            uint256 ratio = sushiValueA.add(sushiValueB).preciseMul(uniValueA).preciseMul(uniValueB).preciseDiv(uniValueA.add(uniValueB).preciseMul(sushiValueA).preciseMul(sushiValueB));
            return ratio.preciseDiv(ratio.add(PreciseUnitMath.PRECISE_UNIT));
        }
    }

    function _checkApprovals(uint256 _uniAmount, uint256 _sushiAmount, ERC20 token) internal {
        if (token.allowance(address(this), address(uniRouter)) < _uniAmount) {
            token.approve(address(uniRouter), PreciseUnitMath.MAX_UINT_256);
        }
        if (token.allowance(address(this), address(sushiRouter)) < _sushiAmount) {
            token.approve(address(sushiRouter), PreciseUnitMath.MAX_UINT_256);
        }
    }
}
