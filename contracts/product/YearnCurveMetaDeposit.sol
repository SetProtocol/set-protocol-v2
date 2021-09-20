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

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { IMetaPoolZap } from "../interfaces/external/IMetaPoolZap.sol";
import { ICurveRegistry } from "../interfaces/external/ICurveRegistry.sol";
import { IYearnVault } from "../interfaces/external/IYearnVault.sol";

/**
 * @title   YearnCurveMetaDeposit
 * @author  Set Protocol
 * @dev     Helper contract which can deposit an underlying token into a curve metapool and wrap it into a yToken
 *          in a single transaction.
 * @notice  Only works for the Meta USD and Meta BTC Curve metapools
 */
contract YearnCurveMetaDeposit {

    IMetaPoolZap public metaPoolZap;
    ICurveRegistry public curveRegistry;

    /**
     * Sets the state variables
     *
     * @param _curveRegistry    address of the curve registry contract
     * @param _metaPoolZap      address of curve metapool zap contract (there is one for each metapool)
     */
    constructor(ICurveRegistry _curveRegistry, IMetaPoolZap _metaPoolZap) public {
        curveRegistry = _curveRegistry;
        metaPoolZap = _metaPoolZap;
    }

    /**
     * Executes a single token deposit into a curve metapool and wraps the resulting LP token into a yearn yToken
     *
     * @param _yearnToken           yearn vault token to receive
     * @param _inputToken           input token for the curve single token deposit
     * @param _inputTokenAmount     amount of input tokens to spend
     * @param _minYTokenReceive     minimum amount of yTokens to recieve back
     */
    function deposit(
        IYearnVault _yearnToken,
        IERC20 _inputToken,
        uint256 _inputTokenAmount,
        uint256 _minYTokenReceive
    )
        external
    {
        address lpToken = _yearnToken.token();
        address pool = curveRegistry.get_pool_from_lp_token(lpToken);

        _inputToken.transferFrom(msg.sender, address(this), _inputTokenAmount);

        _handleApprove(_inputToken, address(metaPoolZap), _inputTokenAmount);

        uint256[4] memory depositAmounts = [uint256(0), uint256(0), uint256(0), uint256(0)];
        uint tokenIndex = _getTokenIndex(pool, _inputToken);
        depositAmounts[tokenIndex] = _inputTokenAmount;
        uint256 lpTokens = metaPoolZap.add_liquidity(pool, depositAmounts, 0, address(this));

        _handleApprove(IERC20(lpToken), address(_yearnToken), lpTokens);
        uint256 yTokens = _yearnToken.deposit(lpTokens);

        require(yTokens >= _minYTokenReceive, "YearnCurveMetaDeposit: insufficient output");

        IERC20(address(_yearnToken)).transfer(msg.sender, yTokens);
    }

    function _handleApprove(IERC20 _token, address _to, uint256 _amount) internal {
        if (_token.allowance(address(this), _to) < _amount) {
            _token.approve(_to, uint256(-1));
        }
    }

    function _getTokenIndex(address _pool, IERC20 _token) internal returns (uint256) {
        address[8] memory tokens = curveRegistry.get_underlying_coins(_pool);
        for (uint256 i = 0; i < 8; i++) {
            if (tokens[i] == address(_token)) return i;
        }
        revert("YearnCurveMetaDeposit: token not in pool");
    }
}