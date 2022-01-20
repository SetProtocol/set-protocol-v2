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
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import "hardhat/console.sol";

/**
 @title Contract to exchange RGT with TRIBE post-merger
*/
contract TribePegExchangerMock {
    using SafeERC20 for IERC20;

    /// @notice the multiplier applied to RGT before converting to TRIBE scaled up by 1e9
    uint256 public constant exchangeRate = 26705673430; // 26.7 TRIBE / RGT
    /// @notice the granularity of the exchange rate
    uint256 public constant scalar = 1e9;

    event Exchange(address indexed from, uint256 amountIn, uint256 amountOut);

    address public immutable rgt;
    address public immutable tribe;

    constructor(address _rgt, address _tribe) public {
        rgt = _rgt;
        tribe = _tribe;
    }

    /// @notice call to exchange held RGT with TRIBE
    /// @param amount the amount to exchange
    function exchange(uint256 amount) public {
        uint256 tribeOut =  amount * exchangeRate / scalar;
        console.log("starting transfer");
        console.log(tribeOut);
        IERC20(rgt).safeTransferFrom(msg.sender, address(this), amount);
        console.log("transferred rgt");
        console.log(IERC20(tribe).balanceOf(tribe));
        IERC20(tribe).safeTransfer(msg.sender, tribeOut);
        console.log("transferred tribe");
        emit Exchange(msg.sender, amount, tribeOut);
    }
}