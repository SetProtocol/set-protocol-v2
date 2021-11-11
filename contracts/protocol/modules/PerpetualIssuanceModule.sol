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

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

import { DebtIssuanceModule } from "./DebtIssuanceModule.sol";
import { IController } from "../../interfaces/IController.sol";
import { IModuleIssuanceHookV2 } from "../../interfaces/IModuleIssuanceHookV2.sol";
import { Invoke } from "../lib/Invoke.sol";
import { ISetToken } from "../../interfaces/ISetToken.sol";
import { IssuanceValidationUtils } from "../lib/IssuanceValidationUtils.sol";
import { Position } from "../lib/Position.sol";

/**
 * @title DebtIssuanceModuleV2
 * @author Set Protocol
 *
 * The DebtIssuanceModuleV2 is a module that enables users to issue and redeem SetTokens that contain default and all
 * external positions, including debt positions. Module hooks are added to allow for syncing of positions, and component
 * level hooks are added to ensure positions are replicated correctly. The manager can define arbitrary issuance logic
 * in the manager hook, as well as specify issue and redeem fees.
 * 
 * NOTE: 
 * The getRequiredComponentIssuanceUnits function on this module assumes that Default token balances will be synced on every issuance
 * and redemption. If token balances are not being synced it will over-estimate the amount of tokens required to issue a Set.
 */
contract PerpetualIssuanceModule is DebtIssuanceModule {

    constructor(IController _controller) public DebtIssuanceModule(_controller) {}

    function getRequiredComponentIssuanceUnits(
        ISetToken _setToken,
        uint256 _quantity
    )
        external
        view
        override
        returns (address[] memory, uint256[] memory, uint256[] memory)
    {
        (
            uint256 totalQuantity,,
        ) = calculateTotalFees(_setToken, _quantity, true);

        int256[] memory issuanceAdjustments = _calculateIssuanceAdjustments(_setToken, totalQuantity);

        return _calculateRequiredComponentIssuanceUnits(_setToken, totalQuantity, true);
    }

    function getRequiredComponentRedemptionUnits(
        ISetToken _setToken,
        uint256 _quantity
    )
        external
        view
        override
        returns (address[] memory, uint256[] memory, uint256[] memory)
    {
        (
            uint256 totalQuantity,,
        ) = calculateTotalFees(_setToken, _quantity, false);

        int256[] memory redemptionAdjustments = _calculateRedemptionAdjustments(_setToken, totalQuantity);

        return _calculateRequiredComponentIssuanceUnits(_setToken, totalQuantity, false);
    }

    function _calculateIssuanceAdjustments(
        ISetToken _setToken,
        uint256 _quantity
    )
        internal
        view
        returns (int256[] memory) 
    {
        uint256 componentsLength = _setToken.getComponents().length;
        int256[] memory cumulativeAdjustments = new int256[](componentsLength);

        address[] memory issuanceHooks = issuanceSettings[_setToken].moduleIssuanceHooks;
        for (uint256 i = 0; i < issuanceHooks.length; i++) {
            int256[] memory adjustments = IModuleIssuanceHookV2(issuanceHooks[i]).getIssuanceAdjustments(_setToken, _quantity);

            for (uint256 j = 0; j < componentsLength; i++) {
                cumulativeAdjustments[j] = cumulativeAdjustments[j].add(adjustments[j]);
            }
        }

        return cumulativeAdjustments;
    }

    function _calculateRedemptionAdjustments(
        ISetToken _setToken,
        uint256 _quantity
    )
        internal
        view
        returns (int256[] memory) 
    {
        uint256 componentsLength = _setToken.getComponents().length;
        int256[] memory cumulativeAdjustments = new int256[](componentsLength);

        address[] memory issuanceHooks = issuanceSettings[_setToken].moduleIssuanceHooks;
        for (uint256 i = 0; i < issuanceHooks.length; i++) {
            int256[] memory adjustments = IModuleIssuanceHookV2(issuanceHooks[i]).getRedemptionAdjustments(_setToken, _quantity);

            for (uint256 j = 0; j < componentsLength; i++) {
                cumulativeAdjustments[j] = cumulativeAdjustments[j].add(adjustments[j]);
            }
        }

        return cumulativeAdjustments;
    }
}