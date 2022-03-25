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

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Address } from "@openzeppelin/contracts/utils/Address.sol";

// Minimal Curve Eth/StEth Stableswap Pool
contract CurveEthStEthExchangeMock is ReentrancyGuard {

    using SafeERC20 for IERC20;
    using SafeMath for uint256;
    using SafeMath for int128;
    using Address for address;

    address[] coins;

    constructor(address[] memory _coins) public {
        require(_coins[0] == address(0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE));
        require(_coins[1] != address(0));
        coins = _coins;
    }

    function add_liquidity(uint256[] memory _amounts, uint256 _min_mint_amount) payable external nonReentrant returns (uint256) {
        require(_amounts[0] == msg.value, "Eth sent should equal amount");
        IERC20(coins[1]).safeTransferFrom(msg.sender, address(this), _amounts[1]);
        return _min_mint_amount;
    }

    /**
     * @dev             Index values can be found via the `coins` public getter method
     * @param _i        Index value for the coin to send
     * @param _j        Index value of the coin to receive
     * @param _dx       Amount of `i` being exchanged
     * @param _min_dy   Minimum amount of `j` to receive
     * @return          Actual amount of `j` received
     */
    function exchange(int128 _i, int128 _j, uint256 _dx, uint256 _min_dy) payable external nonReentrant returns (uint256) {
        require(_i != _j);
        require(_dx == _min_dy);
        if (_i == 0 && _j == 1) {
        // The caller has sent eth receive stETH
        require(_dx == msg.value);
        IERC20(coins[1]).safeTransfer(msg.sender, _dx);
        } else if (_j == 0 && _i == 1) {
        // The caller has sent stETH to receive ETH
        IERC20(coins[1]).safeTransferFrom(msg.sender, address(this), _dx);
        Address.sendValue(msg.sender, _dx);
        } else {
            revert("Invalid index values");
        }
        return _dx;
    }
}
