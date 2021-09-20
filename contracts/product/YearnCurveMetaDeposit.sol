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

import { I3Pool } from "../interfaces/external/I3Pool.sol";
import { ICurveRegistry } from "../interfaces/external/ICurveRegistry.sol";
import { IYearnVault } from "../interfaces/external/IYearnVault.sol";

contract YearnCurveMetaDeposit {

    I3Pool public threePool;
    ICurveRegistry public curveRegistry;

    constructor(ICurveRegistry _curveRegistry, I3Pool _threePool) public {
        curveRegistry = _curveRegistry;
        threePool = _threePool;
    }

    function deposit(
        IYearnVault _yearnToken,
        uint256 _metaTokenAmount,
        uint256 _minYTokenReceive
    )
        external
    {
        address lpToken = _yearnToken.token();
        address pool = curveRegistry.get_pool_from_lp_token(lpToken);

        IERC20 metatoken = IERC20(curveRegistry.get_coins(pool)[0]);

        metatoken.transferFrom(msg.sender, address(this), _metaTokenAmount);

        _handleApprove(metatoken, address(threePool), _metaTokenAmount);

        uint256[4] memory depositAmounts = [_metaTokenAmount, 0, 0,0];
        uint256 lpTokens = threePool.add_liquidity(pool, depositAmounts, 0, address(this));

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
}