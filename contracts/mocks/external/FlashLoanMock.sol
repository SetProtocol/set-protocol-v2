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
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { IFlashLoanReceiver } from "../../interfaces/external/IFlashLoanReceiver.sol";

import { console } from "hardhat/console.sol";

/**
 * @title FlashLoanMock
 * @author Set Protocol
 *
 * Simple mock Aave flash loan contract. Only works for borrowing a single asset at a time
 */
contract FlashLoanMock {
    using SafeERC20 for IERC20;
    using SafeMath for uint256;

    function flashLoan(
        address receiverAddress,
        address[] calldata assets,
        uint256[] calldata amounts,
        uint256[] calldata modes,
        address /* onBehalfOf */,
        bytes calldata params,
        uint16 /* referralCode */
    )
        external
    {
        require(assets.length == 1);
        require(amounts.length == 1);
        require(modes.length == 1);

        IERC20(assets[0]).safeTransfer(receiverAddress, amounts[0]);

        uint256[] memory premiums = new uint256[](1);
        premiums[0] = amounts[0].mul(9).div(10000);

        IFlashLoanReceiver(receiverAddress).executeOperation(assets, amounts, premiums, msg.sender, params);

        IERC20(assets[0]).safeTransferFrom(receiverAddress, address(this), amounts[0].add(premiums[0]));
    }
}