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
 * @title   Curve3PoolMock
 * @author  Set Protocol
 * @dev     Mock 3Pool contract used for depositing into curve metapools
 */
contract Curve3PoolMock {

    IERC20 public lpToken;
    uint256 public lpAmount;
    IERC20 public metatoken;
    uint256 public metaAmount;

    constructor(IERC20 _lpToken, IERC20 _metatoken, uint256 _lpAmount, uint256 _metaAmount) public {
        lpToken = _lpToken;
        metatoken = _metatoken;
        lpAmount = _lpAmount;
        metaAmount = _metaAmount;
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
        metatoken.transferFrom(msg.sender, address(this), _deposit_amounts[0]);
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
        metatoken.transfer(_receiver, metaAmount);
    }
}