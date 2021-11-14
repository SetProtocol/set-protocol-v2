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
 * @title SlippageIssuanceModule
 * @author Set Protocol
 *
 * The SlippageIssuanceModule is a module that enables users to issue and redeem SetTokens that requires a transaction that incurs slippage.
 * in order to replicate the Set. Like the DebtIssuanceModule, module hooks are added to allow for syncing of positions, and component
 * level hooks are added to ensure positions are replicated correctly. The manager can define arbitrary issuance logic in the manager hook,
 * as well as specify issue and redeem fees. The getRequiredComponentIssuanceUnits and it's redemption counterpart now also include any
 * changes to the position expected to happen during issuance thus providing much better estimations for positions that are synced or require
 * a trade. It is worth noting that this module inherits from DebtIssuanceModule, consequently it can also be used for issuances that do NOT
 * require slippage just by calling the issue and redeem endpoints.
 */
contract SlippageIssuanceModule is DebtIssuanceModule {

    constructor(IController _controller) public DebtIssuanceModule(_controller) {}

    /* ============ External Functions ============ */

    /**
     * Deposits components to the SetToken, replicates any external module component positions and mints 
     * the SetToken. If the token has a debt position all collateral will be transferred in first then debt
     * will be returned to the minting address. If specified, a fee will be charged on issuance.
     *
     * @param _setToken         Instance of the SetToken to issue
     * @param _setQuantity      Quantity of SetToken to issue
     * @param _to               Address to mint SetToken to
     */
    function issueWithSlippage(
        ISetToken _setToken,
        uint256 _setQuantity,
        address[] memory _checkedComponents,
        uint256[] memory _maxTokenAmountsIn,
        address _to
    )
        external
        virtual
        nonReentrant
        onlyValidAndInitializedSet(_setToken)
    {
        _validateInputs(_setQuantity, _checkedComponents, _maxTokenAmountsIn);

        address hookContract = _callManagerPreIssueHooks(_setToken, _setQuantity, msg.sender, _to);

        _callModulePreIssueHooks(_setToken, _setQuantity);

        bool isIssue = true;

        (
            uint256 quantityWithFees,
            uint256 managerFee,
            uint256 protocolFee
        ) = calculateTotalFees(_setToken, _setQuantity, isIssue);
        
        {
            (
                address[] memory components,
                uint256[] memory equityUnits,
                uint256[] memory debtUnits
            ) = _calculateRequiredComponentIssuanceUnits(_setToken, quantityWithFees, isIssue);

            _validateTokenTransferLimits(_checkedComponents, _maxTokenAmountsIn, components, equityUnits, isIssue);

            _resolveEquityPositions(_setToken, quantityWithFees, _to, isIssue, components, equityUnits);
            _resolveDebtPositions(_setToken, quantityWithFees, isIssue, components, debtUnits);
            _resolveFees(_setToken, managerFee, protocolFee);
        }

        _setToken.mint(_to, _setQuantity);

        emit SetTokenIssued(
            _setToken,
            msg.sender,
            _to,
            hookContract,
            _setQuantity,
            managerFee,
            protocolFee
        );
    }

    /**
     * Returns components from the SetToken, unwinds any external module component positions and burns the SetToken.
     * If the token has debt positions, the module transfers in the required debt amounts from the caller and uses
     * those funds to repay the debts on behalf of the SetToken. All debt will be paid down first then equity positions
     * will be returned to the minting address. If specified, a fee will be charged on redeem.
     *
     * @param _setToken         Instance of the SetToken to redeem
     * @param _setQuantity         Quantity of SetToken to redeem
     * @param _to               Address to send collateral to
     */
    function redeemWithSlippage(
        ISetToken _setToken,
        uint256 _setQuantity,
        address[] memory _checkedComponents,
        uint256[] memory _minTokenAmountsOut,
        address _to
    )
        external
        virtual        
        nonReentrant
        onlyValidAndInitializedSet(_setToken)
    {
        _validateInputs(_setQuantity, _checkedComponents, _minTokenAmountsOut);

        _callModulePreRedeemHooks(_setToken, _setQuantity);

        // Place burn after pre-redeem hooks because burning tokens may lead to false accounting of synced positions
        _setToken.burn(msg.sender, _setQuantity);

        bool isIssue = false;

        (
            uint256 quantityNetFees,
            uint256 managerFee,
            uint256 protocolFee
        ) = calculateTotalFees(_setToken, _setQuantity, isIssue);

        (
            address[] memory components,
            uint256[] memory equityUnits,
            uint256[] memory debtUnits
        ) = _calculateRequiredComponentIssuanceUnits(_setToken, quantityNetFees, isIssue);

        _validateTokenTransferLimits(_checkedComponents, _minTokenAmountsOut, components, equityUnits, isIssue);

        _resolveDebtPositions(_setToken, quantityNetFees, isIssue, components, debtUnits);
        _resolveEquityPositions(_setToken, quantityNetFees, _to, isIssue, components, equityUnits);
        _resolveFees(_setToken, managerFee, protocolFee);

        emit SetTokenRedeemed(
            _setToken,
            msg.sender,
            _to,
            _setQuantity,
            managerFee,
            protocolFee
        );
    }

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

    function _validateTokenTransferLimits(
        address[] memory _checkedComponents,
        uint256[] memory _tokenTransferLimits,
        address[] memory _components,
        uint256[] memory _tokenTransferAmounts,
        bool _isIssue
    )
        internal
        pure
    {
        for(uint256 i = 0; i < _checkedComponents.length; i++) {
            (uint256 componentIndex, bool isIn) = _components.indexOf(_checkedComponents[i]);

            require(isIn, "Limit passed for invalid component");

            if (_isIssue) {
                require(_tokenTransferLimits[i] >= _tokenTransferAmounts[componentIndex], "Too many tokens required for issuance");
            } else {
                require(_tokenTransferLimits[i] <= _tokenTransferAmounts[componentIndex], "Too few tokens returned for redemption");
            }
        }
    }

    function _validateInputs(
        uint256 _setQuantity,
        address[] memory _components,
        uint256[] memory _componentLimits
    )
        internal
        pure
    {
        require(_setQuantity > 0, "SetToken quantity must be > 0");

        uint256 componentsLength = _components.length;
        if (componentsLength > 0) {
            require(componentsLength == _componentLimits.length, "Array length mismatch");
            require(!_components.hasDuplicate(), "Cannot duplicate addresses");
        }
    }
}