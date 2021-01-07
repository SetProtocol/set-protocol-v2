/*
    Copyright 2020 Set Labs Inc.

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
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";

import { IController } from "../../interfaces/IController.sol";
import { IManagerIssuanceHook } from "../../interfaces/IManagerIssuanceHook.sol";
import { IModuleIssuanceHook } from "../../interfaces/IModuleIssuanceHook.sol";
import { Invoke } from "../lib/Invoke.sol";
import { ISetToken } from "../../interfaces/ISetToken.sol";
import { ModuleBase } from "../lib/ModuleBase.sol";
import { Position } from "../lib/Position.sol";
import { PreciseUnitMath } from "../../lib/PreciseUnitMath.sol";


/**
 * @title DebtIssuanceModule
 * @author Set Protocol
 *
 * The DebtIssuanceModule is a module that enables users to issue and redeem SetTokens that contain default and all
 * external positions, including debt positions. Module hooks are added to allow for syncing of positions, and component
 * level hooks are added to ensure positions are replicated correctly. The manager can define arbitrary issuance logic
 * in the manager hook, as well as specify issue and redeem fees.
 */
contract DebtIssuanceModule is ModuleBase, ReentrancyGuard {
    using Invoke for ISetToken;
    using Position for ISetToken;
    using PreciseUnitMath for uint256;
    using SafeMath for uint256;
    using SafeCast for int256;
    using SignedSafeMath for int256;

    /* ============ Events ============ */

    event SetTokenIssued(address indexed _setToken, address _issuer, address _to, address _hookContract, uint256 _quantity);
    event SetTokenRedeemed(address indexed _setToken, address _redeemer, address _to, uint256 _quantity);

    /* ============ Structs ============ */

    struct IssuanceSettings {
        uint256 managerIssueFee;
        uint256 managerRedeemFee;
        address feeRecipient;
        IManagerIssuanceHook managerIssuanceHook;
        IModuleIssuanceHook[] moduleIssuanceHooks;
    }

    /* ============ Constants ============ */

    uint256 public constant ISSUANCE_MODULE_PROTOCOL_FEE_SPLIT_INDEX = 0;

    /* ============ State ============ */

    mapping(ISetToken => IssuanceSettings) public issuanceSettings;

    /* ============ Constructor ============ */

    /**
     * Set state controller state variable
     */
    constructor(IController _controller) public ModuleBase(_controller) {}

    /* ============ External Functions ============ */

    /**
     * Deposits components to the SetToken and replicates any external module component positions and mints 
     * the SetToken. If the token has a debt position all collateral will be transferred in first then debt
     * will be returned to the _to address. If specified, a fee will be charged on issuance.
     *
     * @param _setToken         Instance of the SetToken to issue
     * @param _quantity         Quanity of SetToken to issue
     * @param _to               Address to mint SetToken to
     */
    function issue(
        ISetToken _setToken,
        uint256 _quantity,
        address _to
    )
        external
        nonReentrant
        onlyValidAndInitializedSet(_setToken)
    {
        require(_quantity > 0, "Issue quantity must be > 0");

        address hookContract = _callManagerPreIssueHooks(_setToken, _quantity, msg.sender, _to);

        _callModulePreIssueHooks(_setToken, _quantity);

        (
            uint256 totalQuantity,
            uint256 managerFee,
            uint256 protocolFee
        ) = _calculateTotalFees(_setToken, _quantity, true);

        (
            address[] memory components,
            uint256[] memory equityUnits,
            uint256[] memory debtUnits
        ) = getRequiredComponentIssuanceUnits(_setToken, totalQuantity, true);

        _resolveEquityPositions(_setToken, totalQuantity, _to, true, components, equityUnits);
        _resolveDebtPositions(_setToken, totalQuantity, _to, true, components, debtUnits);

        _setToken.mint(_to, _quantity);
        _setToken.mint(issuanceSettings[_setToken].feeRecipient, managerFee);
        _setToken.mint(controller.feeRecipient(), protocolFee);
    }

    /**
     * Initializes this module to the SetToken with issuance-related hooks and fee information. Only callable
     * by the SetToken's manager. Hook addresses are optional. Address(0) means that no hook will be called
     *
     * @param _setToken                     Instance of the SetToken to issue
     * @param _managerIssueFee              Fee to charge on issuance
     * @param _managerRedeemFee             Fee to charge on redemption
     * @param _feeRecipient                 Address to send fees to
     * @param _managerIssuanceHook          Instance of the Manager Contract with the Pre-Issuance Hook function
     */
    function initialize(
        ISetToken _setToken,
        uint256 _managerIssueFee,
        uint256 _managerRedeemFee,
        address _feeRecipient,
        IManagerIssuanceHook _managerIssuanceHook
    )
        external
        onlySetManager(_setToken, msg.sender)
        onlyValidAndPendingSet(_setToken)
    {
        issuanceSettings[_setToken].managerIssueFee = _managerIssueFee;
        issuanceSettings[_setToken].managerRedeemFee = _managerRedeemFee;
        issuanceSettings[_setToken].feeRecipient = _feeRecipient;
        issuanceSettings[_setToken].managerIssuanceHook = _managerIssuanceHook;
        _setToken.initializeModule();
    }

    function removeModule() external override {
        delete issuanceSettings[ISetToken(msg.sender)];
    }

    function getRequiredComponentIssuanceUnits(
        ISetToken _setToken,
        uint256 _quantity,
        bool _isIssue
    )
        public
        view
        returns (address[] memory, uint256[] memory, uint256[] memory)
    {
        (
            address[] memory components,
            int256[] memory equityUnits,
            int256[] memory debtUnits
        ) = _getTotalIssuanceUnits(_setToken);

        uint256[] memory totalEquityUnits = new uint256[](components.length);
        uint256[] memory totalDebtUnits = new uint256[](components.length);
        for (uint256 i = 0; i < components.length; i++) {
            // Use preciseMulCeil to round up to ensure overcollateration when small issue quantities are provided
            // and preciseMul to round down to ensure overcollateration when small redeem quantities are provided
            totalEquityUnits[i] = _isIssue ?
                equityUnits[i].toUint256().preciseMulCeil(_quantity) :
                equityUnits[i].toUint256().preciseMul(_quantity);

            totalDebtUnits[i] = _isIssue ?
                debtUnits[i].toUint256().preciseMul(_quantity) :
                debtUnits[i].toUint256().preciseMulCeil(_quantity);
        }

        return (components, totalEquityUnits, totalDebtUnits);
    }

    /* ============ Internal Functions ============ */

    function _calculateTotalFees(
        ISetToken _setToken,
        uint256 _quantity,
        bool _isIssue
    )
        internal
        view
        returns (uint256, uint256, uint256)
    {
        uint256 protocolFeeSplit = controller.getModuleFee(address(this), ISSUANCE_MODULE_PROTOCOL_FEE_SPLIT_INDEX);
        uint256 managerFeeRate = _isIssue ? issuanceSettings[_setToken].managerIssueFee : issuanceSettings[_setToken].managerRedeemFee;
        
        uint256 totalFee = managerFeeRate.preciseMul(_quantity);
        uint256 protocolFee = totalFee.preciseMul(protocolFeeSplit);
        uint256 managerFee = totalFee.sub(protocolFee);

        uint256 totalQuantity = _isIssue ? _quantity.add(totalFee) : _quantity.sub(totalFee);

        return (totalQuantity, managerFee, protocolFee);
    }

    function _getTotalIssuanceUnits(
        ISetToken _setToken
    )
        internal
        view
        returns (address[] memory, int256[] memory, int256[] memory)
    {
        address[] memory components = _setToken.getComponents();
        int256[] memory equityUnits = new int256[](components.length);
        int256[] memory debtUnits = new int256[](components.length);

        for (uint256 i = 0; i < components.length; i++) {
            address component = components[i];
            int256 cumulativeEquity = _setToken.getDefaultPositionRealUnit(component);
            int256 cumulativeDebt = 0;
            address[] memory externalPositions = _setToken.getExternalPositionModules(component);

            if (externalPositions.length > 0) {
                for (uint256 j = 0; j < externalPositions.length; j++) { 
                    int256 externalPositionUnit = _setToken.getExternalPositionRealUnit(component, externalPositions[j]);
                    if (externalPositionUnit > 0) {
                        cumulativeEquity += externalPositionUnit;
                    } else {
                        cumulativeDebt += externalPositionUnit;
                    }
                }
            }

            equityUnits[i] = cumulativeEquity;
            debtUnits[i] = cumulativeDebt;
        }

        return (components, equityUnits, debtUnits);
    }

    function _resolveEquityPositions(
        ISetToken _setToken,
        uint256 _quantity,
        address _to,
        bool _isIssue,
        address[] memory _components,
        uint256[] memory _componentQuantities
    )
        internal
    {
        for (uint256 i = 0; i < _components.length; i++) {
            address component = _components[i];
            uint256 componentQuantity = _componentQuantities[i];
            if (componentQuantity > 0) {
                if (_isIssue) {
                    transferFrom(
                        IERC20(component),
                        msg.sender,
                        address(_setToken),
                        componentQuantity
                    );

                    _executeExternalPositionHooks(_setToken, _quantity, component, true);
                } else {
                    _executeExternalPositionHooks(_setToken, _quantity, component, false);

                    _setToken.strictInvokeTransfer(
                        component,
                        _to,
                        componentQuantity
                    );
                }
            }
        }
    }

    function _resolveDebtPositions(
        ISetToken _setToken,
        uint256 _quantity,
        address _to,
        bool _isIssue,
        address[] memory _components,
        uint256[] memory _componentQuantities
    )
        internal
    {
        for (uint256 i = 0; i < _components.length; i++) {
            address component = _components[i];
            uint256 componentQuantity = _componentQuantities[i];
            if (componentQuantity > 0) {
                if (_isIssue) {
                    _executeExternalPositionHooks(_setToken, _quantity, component, true);
                    _setToken.strictInvokeTransfer(
                        component,
                        _to,
                        componentQuantity
                    );
                } else {
                    transferFrom(
                        IERC20(component),
                        msg.sender,
                        address(_setToken),
                        componentQuantity
                    );
                    _executeExternalPositionHooks(_setToken, _quantity, component, false);
                }
            }
        }
    }

    /**
     * If a pre-issue hook has been configured, call the external-protocol contract. Pre-issue hook logic
     * can contain arbitrary logic including validations, external function calls, etc.
     * Note: All modules with external positions must implement ExternalPositionIssueHooks
     */
    function _callManagerPreIssueHooks(
        ISetToken _setToken,
        uint256 _quantity,
        address _caller,
        address _to
    )
        internal
        returns(address)
    {
        IManagerIssuanceHook preIssueHook = issuanceSettings[_setToken].managerIssuanceHook;
        if (address(preIssueHook) != address(0)) {
            preIssueHook.invokePreIssueHook(_setToken, _quantity, _caller, _to);
            return address(preIssueHook);
        }

        return address(0);
    }
    
    function _callModulePreIssueHooks(ISetToken _setToken, uint256 _quantity) internal {
        IModuleIssuanceHook[] memory issuanceHooks = issuanceSettings[_setToken].moduleIssuanceHooks;
        for (uint256 i = 0; i < issuanceHooks.length; i++) {
            issuanceHooks[i].moduleIssueHook(_setToken, _quantity);
        }
    }

    /**
     * For each component's external module positions, calculate the total notional quantity, and 
     * call the module's issue hook or redeem hook.
     * Note: It is possible that these hooks can cause the states of other modules to change.
     * It can be problematic if the a hook called an external function that called back into a module, resulting in state inconsistencies.
     */
    function _executeExternalPositionHooks(
        ISetToken _setToken,
        uint256 _setTokenQuantity,
        address _component,
        bool _isIssue
    )
        internal
    {
        address[] memory externalPositionModules = _setToken.getExternalPositionModules(_component);
        for (uint256 i = 0; i < externalPositionModules.length; i++) {
            if (_isIssue) {
                IModuleIssuanceHook(externalPositionModules[i]).componentIssueHook(_setToken, _setTokenQuantity, _component);
            } else {
                IModuleIssuanceHook(externalPositionModules[i]).componentRedeemHook(_setToken, _setTokenQuantity, _component);
            }
        }
    }
}