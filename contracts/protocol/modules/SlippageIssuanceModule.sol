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
contract SlippageIssuanceModule is DebtIssuanceModule {

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
        bool isIssue = true;

        (
            uint256 totalQuantity,,
        ) = calculateTotalFees(_setToken, _quantity, isIssue);

        (
            int256[] memory equityIssuanceAdjustments,
            int256[] memory debtIssuanceAdjustments
        )= _calculateAdjustments(_setToken, totalQuantity, isIssue);

        return _calculateAdjustedComponentIssuanceUnits(
            _setToken,
            totalQuantity,
            isIssue,
            equityIssuanceAdjustments,
            debtIssuanceAdjustments
        );
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
        bool isIssue = false;

        (
            uint256 totalQuantity,,
        ) = calculateTotalFees(_setToken, _quantity, isIssue);

        (
            int256[] memory equityRedemptionAdjustments,
            int256[] memory debtRedemptionAdjustments
        )= _calculateAdjustments(_setToken, totalQuantity, isIssue);

        return _calculateAdjustedComponentIssuanceUnits(
            _setToken,
            totalQuantity,
            isIssue,
            equityRedemptionAdjustments,
            debtRedemptionAdjustments
        );
    }

    function _calculateAdjustedComponentIssuanceUnits(
        ISetToken _setToken,
        uint256 _quantity,
        bool _isIssue,
        int256[] memory _equityAdjustments,
        int256[] memory _debtAdjustments
    )
        internal
        view
        returns (address[] memory, uint256[] memory, uint256[] memory)
    {
        (
            address[] memory components,
            uint256[] memory equityUnits,
            uint256[] memory debtUnits
        ) = _getTotalIssuanceUnits(_setToken);

        // NOTE: components.length isn't stored in local variable to avoid stak too deep errors. Since this function is used
        // by view functions intended to be queried off-chain this seems acceptable
        uint256[] memory totalEquityUnits = new uint256[](components.length);
        uint256[] memory totalDebtUnits = new uint256[](components.length);
        for (uint256 i = 0; i < components.length; i++) {
            // Use preciseMulCeil to round up to ensure overcollateration when small issue quantities are provided
            // and preciseMul to round down to ensure overcollateration when small redeem quantities are provided
            uint256 adjustedEquityUnits = _equityAdjustments[i] >= 0 ? equityUnits[i].add(_equityAdjustments[i].toUint256()) :
                equityUnits[i].sub(_equityAdjustments[i].mul(-1).toUint256());

            totalEquityUnits[i] = _isIssue ?
                adjustedEquityUnits.preciseMulCeil(_quantity) :
                adjustedEquityUnits.preciseMul(_quantity);

            uint256 adjustedDebtUnits = _debtAdjustments[i] >= 0 ? debtUnits[i].add(_debtAdjustments[i].toUint256()) :
                debtUnits[i].sub(_debtAdjustments[i].mul(-1).toUint256());
                
            totalDebtUnits[i] = _isIssue ?
                adjustedDebtUnits.preciseMul(_quantity) :
                adjustedDebtUnits.preciseMulCeil(_quantity);
        }

        return (components, totalEquityUnits, totalDebtUnits);
    }

    function _calculateAdjustments(
        ISetToken _setToken,
        uint256 _quantity,
        bool _isIssue
    )
        internal
        view
        returns (int256[] memory, int256[] memory) 
    {
        uint256 componentsLength = _setToken.getComponents().length;
        int256[] memory cumulativeEquityAdjustments = new int256[](componentsLength);
        int256[] memory cumulativeDebtAdjustments = new int256[](componentsLength);

        address[] memory issuanceHooks = issuanceSettings[_setToken].moduleIssuanceHooks;
        for (uint256 i = 0; i < issuanceHooks.length; i++) {
            (
                int256[] memory equityAdjustments,
                int256[] memory debtAdjustments
            ) = _isIssue ? IModuleIssuanceHookV2(issuanceHooks[i]).getIssuanceAdjustments(_setToken, _quantity) :
                IModuleIssuanceHookV2(issuanceHooks[i]).getRedemptionAdjustments(_setToken, _quantity);

            for (uint256 j = 0; j < componentsLength; j++) {
                cumulativeEquityAdjustments[j] = cumulativeEquityAdjustments[j].add(equityAdjustments[j]);
                cumulativeDebtAdjustments[j] = cumulativeDebtAdjustments[j].add(debtAdjustments[j]);
            }
        }

        return (cumulativeEquityAdjustments, cumulativeDebtAdjustments);
    }
}