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

import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

// Minimal Curve Stableswap Pool for two coins
contract CurveTwoPoolStableswapMock is ReentrancyGuard, ERC20 {
    using SafeERC20 for IERC20;
    using SafeMath for uint256;
    using SafeMath for int128;
    using Address for address;

    address[2] tokens;

    constructor(
        string memory _name,
        string memory _symbol,
        address[2] memory _tokens
    ) public ERC20(_name, _symbol) {
        tokens = _tokens;
    }

    function add_liquidity(uint256[2] memory _amounts, uint256 _min_mint_amount) external nonReentrant {
        for (uint i = 0; i < _amounts.length; i++) {
            IERC20(tokens[i]).safeTransferFrom(msg.sender, address(this), _amounts[i]);
        }
        uint256 mint_amount = _amounts[0].add(_amounts[1]);
        require(_min_mint_amount <= mint_amount, "invalid min mint amount");

        _mint(msg.sender, mint_amount);
    }

    function remove_liquidity(uint256 amount, uint256[2] calldata min_amounts) external nonReentrant {
        _burn(msg.sender, amount);

        for (uint i = 0; i < min_amounts.length; i++) {
            require(amount.div(2) >= min_amounts[i], "invalid min amounts");
            IERC20(tokens[i]).safeTransfer(msg.sender, amount.div(2));
        }
    }

    function remove_liquidity_one_coin(
        uint256 amount,
        int128 i,
        uint256 mim_received
    ) external {
        _burn(msg.sender, amount);

        require(amount >= mim_received, "invalid min received");
        IERC20(tokens[uint256(uint128(i))]).safeTransfer(msg.sender, amount);
    }

    function coins(uint256 _index) external view returns (address) {
        return tokens[_index];
    }

    function balances(uint256 _index) external view returns(uint256) {
        return IERC20(tokens[_index]).balanceOf(address(this));
    }
}
