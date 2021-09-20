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

/**
 * @title   CurveMetaPoolZapMock
 * @author  Set Protocol
 * @dev     Mock Meta Pool Zap contract used for depositing into curve metapools
 * @notice  Assumes that all deposits/withdrawals are one sided with the input/output token being underlyingToken
 */
contract CurveMetaPoolZapMock {

    IERC20 public lpToken;
    uint256 public lpAmount;
    IERC20 public underlyingToken;
    uint256 public inputAmount;

    constructor(IERC20 _lpToken, IERC20 _underlyingToken, uint256 _lpAmount, uint256 _inputAmount) public {
        lpToken = _lpToken;
        underlyingToken = _underlyingToken;
        lpAmount = _lpAmount;
        inputAmount = _inputAmount;
    }
    
    function add_liquidity(
        address /* _pool */,
        uint256[4] calldata _deposit_amounts,
        uint256 /* _min_mint_amount */,
        address _receiver
    )
        external
        returns (uint256)
    {
        underlyingToken.transferFrom(msg.sender, address(this), _deposit_amounts[0]);
        lpToken.transfer(_receiver, lpAmount);

        return lpAmount;
    }

    function remove_liquidity_one_coin(
        address /* _pool */,
        uint256 _burn_amount,
        int128 /* i */,
        uint256 /* _min_amount */,
        address _receiver
    )
        external
    {
        lpToken.transferFrom(msg.sender, address(this), _burn_amount);
        underlyingToken.transfer(_receiver, inputAmount);
    }
}