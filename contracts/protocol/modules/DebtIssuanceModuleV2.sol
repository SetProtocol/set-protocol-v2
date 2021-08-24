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
import { Invoke } from "../lib/Invoke.sol";
import { ISetToken } from "../../interfaces/ISetToken.sol";
import { IssuanceUtils } from "../lib/IssuanceUtils.sol";

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
 * DebtIssuanceModule contract confirmed increase/decrease in balance of component held by the SetToken after every transfer in/out
 * for each component during issuance/redemption. This contract replaces those strict checks with slightly looser checks which 
 * ensure that the SetToken remains collateralized after every transfer in/out for each component during issuance/redemption.
 * This module should be used to issue/redeem SetToken whose one or more components return a balance value with +/-1 wei error.
 * For example, this module can be used to issue/redeem SetTokens which has one or more aTokens as its components.
 */
contract DebtIssuanceModuleV2 is DebtIssuanceModule {
    
    /* ============ Constructor ============ */
    
    constructor(IController _controller) public DebtIssuanceModule(_controller) {}

    /* ============ Internal Functions ============ */
    
    /**
     * Resolve equity positions associated with SetToken. On issuance, the total equity position for an asset (including default and external
     * positions) is transferred in. Then any external position hooks are called to transfer the external positions to their necessary place.
     * On redemption all external positions are recalled by the external position hook, then those position plus any default position are
     * transferred back to the _to address.
     *
     * NOTE: Overrides DebtIssuanceModule#_resolveEquityPositions internal function and adds undercollateralization checks in place of the
     * previous default strict balances checks. The undercollateralization checks are implemented in IssuanceUtils library and they revert upon
     * undercollateralization of the SetToken post component transfer.
     */
    function _resolveEquityPositions(
        ISetToken _setToken,
        uint256 _quantity,
        address _to,
        bool _isIssue,
        address[] memory _components,
        uint256[] memory _componentEquityQuantities
    )
        internal
        override
    {
        for (uint256 i = 0; i < _components.length; i++) {
            address component = _components[i];
            uint256 componentQuantity = _componentEquityQuantities[i];
            if (componentQuantity > 0) {
                if (_isIssue) {
                    // Call SafeERC20#safeTransferFrom instead of ExplicitERC20#transferFrom
                    SafeERC20.safeTransferFrom(
                        IERC20(component),
                        msg.sender,
                        address(_setToken),
                        componentQuantity
                    );

                    IssuanceUtils.validateCollateralizationPostTransferInPreHook(_setToken, component, componentQuantity, _isIssue, _quantity);

                    _executeExternalPositionHooks(_setToken, _quantity, IERC20(component), true, true);
                } else {
                    _executeExternalPositionHooks(_setToken, _quantity, IERC20(component), false, true);

                    // Call Invoke#invokeTransfer instead of Invoke#strictInvokeTransfer
                    _setToken.invokeTransfer(component, _to, componentQuantity);

                    IssuanceUtils.validateCollateralizationPostTransferOut(_setToken, component, _isIssue, _quantity);
                }
            }
        }
    }

    /**
     * Resolve debt positions associated with SetToken. On issuance, debt positions are entered into by calling the external position hook. The
     * resulting debt is then returned to the calling address. On redemption, the module transfers in the required debt amount from the caller
     * and uses those funds to repay the debt on behalf of the SetToken.
     *
     * NOTE: Overrides DebtIssuanceModule#_resolveDebtPositions internal function and adds undercollateralization checks in place of the
     * previous default strict balances checks. The undercollateralization checks are implemented in IssuanceUtils library and they revert upon
     * undercollateralization of the SetToken post component transfer.
     */
    function _resolveDebtPositions(
        ISetToken _setToken,
        uint256 _quantity,
        bool _isIssue,
        address[] memory _components,
        uint256[] memory _componentDebtQuantities
    )
        internal
        override
    {
        for (uint256 i = 0; i < _components.length; i++) {
            address component = _components[i];
            uint256 componentQuantity = _componentDebtQuantities[i];
            if (componentQuantity > 0) {
                if (_isIssue) {
                    _executeExternalPositionHooks(_setToken, _quantity, IERC20(component), true, false);
                    
                    // Call Invoke#invokeTransfer instead of Invoke#strictInvokeTransfer
                    _setToken.invokeTransfer(component, msg.sender, componentQuantity);

                    IssuanceUtils.validateCollateralizationPostTransferOut(_setToken, component, _isIssue, _quantity);
                } else {
                    // Call SafeERC20#safeTransferFrom instead of ExplicitERC20#transferFrom
                    SafeERC20.safeTransferFrom(
                        IERC20(component),
                        msg.sender,
                        address(_setToken),
                        componentQuantity
                    );

                    IssuanceUtils.validateCollateralizationPostTransferInPreHook(_setToken, component, componentQuantity, _isIssue, _quantity);

                    _executeExternalPositionHooks(_setToken, _quantity, IERC20(component), false, false);
                }
            }
        }
    }
}