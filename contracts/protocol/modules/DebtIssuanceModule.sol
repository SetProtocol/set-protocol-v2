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
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";

import { AddressArrayUtils } from "../../lib/AddressArrayUtils.sol";
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
    using AddressArrayUtils for address[];

    /* ============ Events ============ */

    event SetTokenIssued(
        address indexed _setToken,
        address indexed _issuer,
        address indexed _to,
        address _hookContract,
        uint256 _quantity,
        uint256 _managerFee,
        uint256 _protocolFee
    );
    event SetTokenRedeemed(
        address indexed _setToken,
        address indexed _redeemer,
        address indexed _to,
        uint256 _quantity,
        uint256 _managerFee,
        uint256 _protocolFee
    );
    event FeeRecipientUpdated(address indexed _setToken, address _newFeeRecipient);
    event IssueFeeUpdated(address indexed _setToken, uint256 _newIssueFee);
    event RedeemFeeUpdated(address indexed _setToken, uint256 _newRedeemFee);

    /* ============ Structs ============ */

    struct IssuanceSettings {
        uint256 maxManagerFee;
        uint256 managerIssueFee;
        uint256 managerRedeemFee;
        address feeRecipient;
        IManagerIssuanceHook managerIssuanceHook;
        address[] moduleIssuanceHooks;
    }

    /* ============ Constants ============ */

    uint256 private constant ISSUANCE_MODULE_PROTOCOL_FEE_SPLIT_INDEX = 0;

    /* ============ State ============ */

    mapping(ISetToken => IssuanceSettings) public issuanceSettings;

    /* ============ Constructor ============ */

    /**
     * Set state controller state variable
     */
    constructor(IController _controller) public ModuleBase(_controller) {}

    /* ============ External Functions ============ */

    /**
     * Deposits components to the SetToken, replicates any external module component positions and mints 
     * the SetToken. If the token has a debt position all collateral will be transferred in first then debt
     * will be returned to the minting address. If specified, a fee will be charged on issuance.
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
        ) = _calculateRequiredComponentIssuanceUnits(_setToken, totalQuantity, true);

        _resolveEquityPositions(_setToken, totalQuantity, _to, true, components, equityUnits);
        _resolveDebtPositions(_setToken, totalQuantity, true, components, debtUnits);
        _resolveFees(_setToken, managerFee, protocolFee);

        _setToken.mint(_to, _quantity);

        emit SetTokenIssued(
            address(_setToken),
            msg.sender,
            _to,
            hookContract,
            totalQuantity,
            managerFee,
            protocolFee
        );
    }

    /**
     * Returns components from the SetToken, unwinds any external module component positions and burns 
     * the SetToken. If the token has a debt position all debt will be paid down first then equity positions
     * will be returned to the minting address. If specified, a fee will be charged on redeem.
     *
     * @param _setToken         Instance of the SetToken to redeem
     * @param _quantity         Quanity of SetToken to redeem
     * @param _to               Address to send collateral to
     */
    function redeem(
        ISetToken _setToken,
        uint256 _quantity,
        address _to
    )
        external
        nonReentrant
        onlyValidAndInitializedSet(_setToken)
    {
        require(_quantity > 0, "Redeem quantity must be > 0");

        _callModulePreRedeemHooks(_setToken, _quantity);

        (
            uint256 totalQuantity,
            uint256 managerFee,
            uint256 protocolFee
        ) = _calculateTotalFees(_setToken, _quantity, false);

        (
            address[] memory components,
            uint256[] memory equityUnits,
            uint256[] memory debtUnits
        ) = _calculateRequiredComponentIssuanceUnits(_setToken, totalQuantity, false);

        _setToken.burn(msg.sender, _quantity);

        _resolveDebtPositions(_setToken, totalQuantity, false, components, debtUnits);
        _resolveEquityPositions(_setToken, totalQuantity, _to, false, components, equityUnits);
        _resolveFees(_setToken, managerFee, protocolFee);

        emit SetTokenRedeemed(
            address(_setToken),
            msg.sender,
            _to,
            totalQuantity,
            managerFee,
            protocolFee
        );
    }

    /**
     * MANAGER ONLY: Updates address receiving issue/redeem fees for a given SetToken.
     *
     * @param _setToken             Instance of the SetToken to update fee recipient
     * @param _newFeeRecipient      New fee recipient address
     */
    function updateFeeRecipient(
        ISetToken _setToken,
        address _newFeeRecipient
    )
        external
        onlyManagerAndValidSet(_setToken)
    {
        require(_newFeeRecipient != address(0), "Fee Recipient must be non-zero address.");

        issuanceSettings[_setToken].feeRecipient = _newFeeRecipient;

        emit FeeRecipientUpdated(address(_setToken), _newFeeRecipient);
    }

    /**
     * MANAGER ONLY: Updates issue fee for passed SetToken
     *
     * @param _setToken             Instance of the SetToken to update issue fee
     * @param _newIssueFee          New fee amount in preciseUnits (1% = 10^16)
     */
    function updateIssueFee(
        ISetToken _setToken,
        uint256 _newIssueFee
    )
        external
        onlyManagerAndValidSet(_setToken)
    {
        require(_newIssueFee <= issuanceSettings[_setToken].maxManagerFee, "Issue fee can't exceed maximum");

        issuanceSettings[_setToken].managerIssueFee = _newIssueFee;

        emit IssueFeeUpdated(address(_setToken), _newIssueFee);
    }

    /**
     * MANAGER ONLY: Updates redeem fee for passed SetToken
     *
     * @param _setToken             Instance of the SetToken to update redeem fee
     * @param _newRedeemFee         New fee amount in preciseUnits (1% = 10^16)
     */
    function updateRedeemFee(
        ISetToken _setToken,
        uint256 _newRedeemFee
    )
        external
        onlyManagerAndValidSet(_setToken)
    {
        require(_newRedeemFee <= issuanceSettings[_setToken].maxManagerFee, "Redeem fee can't exceed maximum");

        issuanceSettings[_setToken].managerRedeemFee = _newRedeemFee;

        emit RedeemFeeUpdated(address(_setToken), _newRedeemFee);
    }

    /**
     * MODULE ONLY: Adds calling module to array of modules that require they be called before component hooks are
     * called. Can be used to sync debt positions before issuance.
     *
     * @param _setToken             Instance of the SetToken to issue
     */
    function register(ISetToken _setToken) external onlyModule(_setToken) {
        require(_setToken.isInitializedModule(address(this)), "DebtIssuanceModule not initialized");
        require(!issuanceSettings[_setToken].moduleIssuanceHooks.contains(msg.sender), "Module already registered.");
        issuanceSettings[_setToken].moduleIssuanceHooks.push(msg.sender);
    }

    /**
     * MODULE ONLY: Removes calling module from array of modules that require they be called before component hooks are
     * called.
     *
     * @param _setToken             Instance of the SetToken to issue
     */
    function unregister(ISetToken _setToken) external onlyModule(_setToken) {
        require(issuanceSettings[_setToken].moduleIssuanceHooks.contains(msg.sender), "Module not registered.");
        issuanceSettings[_setToken].moduleIssuanceHooks = issuanceSettings[_setToken].moduleIssuanceHooks.remove(msg.sender);
    }

    /**
     * Initializes this module to the SetToken with issuance-related hooks and fee information. Only callable
     * by the SetToken's manager. Hook addresses are optional. Address(0) means that no hook will be called
     *
     * @param _setToken                     Instance of the SetToken to issue
     * @param _maxManagerFee                Maximum fee that can be charged on issue and redeem
     * @param _managerIssueFee              Fee to charge on issuance
     * @param _managerRedeemFee             Fee to charge on redemption
     * @param _feeRecipient                 Address to send fees to
     * @param _managerIssuanceHook          Instance of the Manager Contract with the Pre-Issuance Hook function
     */
    function initialize(
        ISetToken _setToken,
        uint256 _maxManagerFee,
        uint256 _managerIssueFee,
        uint256 _managerRedeemFee,
        address _feeRecipient,
        IManagerIssuanceHook _managerIssuanceHook
    )
        external
        onlySetManager(_setToken, msg.sender)
        onlyValidAndPendingSet(_setToken)
    {
        require(_maxManagerFee > 0, "Maximum fee must be greater than 0.");
        require(_managerIssueFee < _maxManagerFee, "Issue fee can't exceed maximum fee");
        require(_managerRedeemFee < _maxManagerFee, "Redeem fee can't exceed maximum fee");

        issuanceSettings[_setToken].maxManagerFee = _maxManagerFee;
        issuanceSettings[_setToken].managerIssueFee = _managerIssueFee;
        issuanceSettings[_setToken].managerRedeemFee = _managerRedeemFee;
        issuanceSettings[_setToken].feeRecipient = _feeRecipient;
        issuanceSettings[_setToken].managerIssuanceHook = _managerIssuanceHook;
        _setToken.initializeModule();
    }

    function removeModule() external override {
        require(issuanceSettings[ISetToken(msg.sender)].moduleIssuanceHooks.length == 0, "Registered modules must be removed.");
        delete issuanceSettings[ISetToken(msg.sender)];
    }

    /* ============ External Getter Functions ============ */

    /**
     * Calculates the amount of each component needed to collateralize passed issue quantity of Sets as well as amount of debt that will
     * be returned to caller. Values DO NOT take into account any updates from pre action manager or module hooks.
     *
     * @param _setToken         Instance of the SetToken to issue
     * @param _quantity         Amount of Sets to be issued/redeemed
     *
     * @return address[]        Array of component addresses making up the Set
     * @return uint256[]        Array of equity notional amounts of each component, respectively, represented as uint256
     * @return uint256[]        Array of debt notional amounts of each component, respectively, represented as uint256
     */
    function getRequiredComponentIssuanceUnits(
        ISetToken _setToken,
        uint256 _quantity
    )
        external
        view
        returns (address[] memory, uint256[] memory, uint256[] memory)
    {
        (
            uint256 totalQuantity,,
        ) = _calculateTotalFees(_setToken, _quantity, true);

        return _calculateRequiredComponentIssuanceUnits(_setToken, totalQuantity, true);
    }

    /**
     * Calculates the amount of each component will be returned on redemption as well as how much debt needs to be paid down to redeem.
     * Values DO NOT take into account any updates from pre action manager or module hooks.
     *
     * @param _setToken         Instance of the SetToken to issue
     * @param _quantity         Amount of Sets to be issued/redeemed
     *
     * @return address[]        Array of component addresses making up the Set
     * @return uint256[]        Array of equity notional amounts of each component, respectively, represented as uint256
     * @return uint256[]        Array of debt notional amounts of each component, respectively, represented as uint256
     */
    function getRequiredComponentRedemptionUnits(
        ISetToken _setToken,
        uint256 _quantity
    )
        external
        view
        returns (address[] memory, uint256[] memory, uint256[] memory)
    {
        (
            uint256 totalQuantity,,
        ) = _calculateTotalFees(_setToken, _quantity, false);

        return _calculateRequiredComponentIssuanceUnits(_setToken, totalQuantity, false);
    }

    function getModuleIssuanceHooks(ISetToken _setToken) external view returns(address[] memory) {
        return issuanceSettings[_setToken].moduleIssuanceHooks;
    }

    /* ============ Internal Functions ============ */

    /**
     * Calculates the manager fee, protocol fee and resulting totalQuantity to use when calculating unit amounts. If fees are charged they
     * are added to the total issue quantity, for example 1% fee on 100 Sets means 101 Sets are minted by caller, the _to address receives
     * 100 and the feeRecipient receives 1. Conversely, on redemption the redeemer will only receive the collateral that collateralizes 99
     * Sets, while the additional Set is given to the feeRecipient.
     *
     * @param _setToken         Instance of the SetToken to issue
     * @param _quantity         Amount of SetToken issuer wants to receive/redeem
     * @param _isIssue          If issuing or redeeming
     *
     * @return uint256          Total amount of Sets to be issued/redeemed net of fees
     * @return uint256          Sets minted to the manager
     * @return uint256          Sets minted to the protocol
     */
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

    /**
     * Calculates the amount of each component needed to collateralize passed issue quantity of Sets as well as amount of debt that will
     * be returned to caller. Can also be used to determine how much collateral will be returned on redemption as well as how much debt
     * needs to be paid down to redeem. Values DO NOT take into account manager fees.
     *
     * @param _setToken         Instance of the SetToken to issue
     * @param _quantity         Amount of Sets to be issued/redeemed
     * @param _isIssue          Whether Sets are being issued or redeemed
     *
     * @return address[]        Array of component addresses making up the Set
     * @return uint256[]        Array of equity notional amounts of each component, respectively, represented as uint256
     * @return uint256[]        Array of debt notional amounts of each component, respectively, represented as uint256
     */
    function _calculateRequiredComponentIssuanceUnits(
        ISetToken _setToken,
        uint256 _quantity,
        bool _isIssue
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

        uint256[] memory totalEquityUnits = new uint256[](components.length);
        uint256[] memory totalDebtUnits = new uint256[](components.length);
        for (uint256 i = 0; i < components.length; i++) {
            // Use preciseMulCeil to round up to ensure overcollateration when small issue quantities are provided
            // and preciseMul to round down to ensure overcollateration when small redeem quantities are provided
            totalEquityUnits[i] = _isIssue ?
                equityUnits[i].preciseMulCeil(_quantity) :
                equityUnits[i].preciseMul(_quantity);

            totalDebtUnits[i] = _isIssue ?
                debtUnits[i].preciseMul(_quantity) :
                debtUnits[i].preciseMulCeil(_quantity);
        }

        return (components, totalEquityUnits, totalDebtUnits);
    }

    /**
     * Sums total debt and equity units for each component, taking into account default and external positions.
     *
     * @param _setToken         Instance of the SetToken to issue
     *
     * @return address[]        Array of component addresses making up the Set
     * @return uint256[]        Array of equity unit amounts of each component, respectively, represented as uint256
     * @return uint256[]        Array of debt unit amounts of each component, respectively, represented as uint256
     */
    function _getTotalIssuanceUnits(
        ISetToken _setToken
    )
        internal
        view
        returns (address[] memory, uint256[] memory, uint256[] memory)
    {
        address[] memory components = _setToken.getComponents();
        uint256[] memory equityUnits = new uint256[](components.length);
        uint256[] memory debtUnits = new uint256[](components.length);

        for (uint256 i = 0; i < components.length; i++) {
            address component = components[i];
            int256 cumulativeEquity = _setToken.getDefaultPositionRealUnit(component);
            int256 cumulativeDebt = 0;
            address[] memory externalPositions = _setToken.getExternalPositionModules(component);

            if (externalPositions.length > 0) {
                for (uint256 j = 0; j < externalPositions.length; j++) { 
                    int256 externalPositionUnit = _setToken.getExternalPositionRealUnit(component, externalPositions[j]);
                    if (externalPositionUnit > 0) {
                        cumulativeEquity = cumulativeEquity.add(externalPositionUnit);
                    } else {
                        cumulativeDebt = cumulativeDebt.add(externalPositionUnit);
                    }
                }
            }

            equityUnits[i] = cumulativeEquity.toUint256();
            debtUnits[i] = cumulativeDebt.mul(-1).toUint256();
        }

        return (components, equityUnits, debtUnits);
    }

    /**
     * Resolve equity positions associated with SetToken. On issuance, the total equity position for an asset (including default and external
     * positions) is transferred in. Then any external position hooks are called to transfer the external positions to their necessary place.
     * On redemption all external positions are recalled by the external position hook, then those position plus any default position are
     * transferred back to the _to address.
     */
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

    /**
     * Resolve debt positions associated with SetToken. On issuance, debt positions are entered into by calling the external position hook. The
     * resulting debt is then returned to the calling address. On redemption, the module transfers in the required debt amount from the caller
     * and uses those funds to repay the debt on behalf of the SetToken.
     */
    function _resolveDebtPositions(
        ISetToken _setToken,
        uint256 _quantity,
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
                        msg.sender,
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

    function _resolveFees(ISetToken _setToken, uint256 managerFee, uint256 protocolFee) internal {
        if (managerFee > 0) {
            _setToken.mint(issuanceSettings[_setToken].feeRecipient, managerFee);
            if (protocolFee > 0) {
                _setToken.mint(controller.feeRecipient(), protocolFee);
            }
        }
    }

    /**
     * If a pre-issue hook has been configured, call the external-protocol contract. Pre-issue hook logic
     * can contain arbitrary logic including validations, external function calls, etc.
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
    
    /**
     * Calls all modules that have registered with the DebtIssuanceModule that they have a moduleIssueHook.
     */
    function _callModulePreIssueHooks(ISetToken _setToken, uint256 _quantity) internal {
        address[] memory issuanceHooks = issuanceSettings[_setToken].moduleIssuanceHooks;
        for (uint256 i = 0; i < issuanceHooks.length; i++) {
            IModuleIssuanceHook(issuanceHooks[i]).moduleIssueHook(_setToken, _quantity);
        }
    }

    /**
     * Calls all modules that have registered with the DebtIssuanceModule that they have a moduleRedeemHook.
     */
    function _callModulePreRedeemHooks(ISetToken _setToken, uint256 _quantity) internal {
        address[] memory issuanceHooks = issuanceSettings[_setToken].moduleIssuanceHooks;
        for (uint256 i = 0; i < issuanceHooks.length; i++) {
            IModuleIssuanceHook(issuanceHooks[i]).moduleRedeemHook(_setToken, _quantity);
        }
    }

    /**
     * For each component's external module positions, calculate the total notional quantity, and 
     * call the module's issue hook or redeem hook.
     * Note: It is possible that these hooks can cause the states of other modules to change.
     * It can be problematic if the hook called an external function that called back into a module, resulting in state inconsistencies.
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