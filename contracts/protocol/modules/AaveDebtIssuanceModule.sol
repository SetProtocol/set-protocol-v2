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
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { DebtIssuanceModule } from "./DebtIssuanceModule.sol";
import { IController } from "../../interfaces/IController.sol";
import { Invoke } from "../lib/Invoke.sol";
import { ISetToken } from "../../interfaces/ISetToken.sol";
import { PreciseUnitMath } from "../../lib/PreciseUnitMath.sol";


/**
 * @title AaveDebtIssuanceModule
 * @author Set Protocol
 *
 * The AaveDebtIssuanceModule is a module that enables users to issue and redeem SetTokens that contain default and all
 * external positions, including debt positions. Module hooks are added to allow for syncing of positions, and component
 * level hooks are added to ensure positions are replicated correctly. The manager can define arbitrary issuance logic
 * in the manager hook, as well as specify issue and redeem fees.
 * Note: This module is designed to issue/redeem SetTokens which hold one or more aTokens as components.
 */
contract AaveDebtIssuanceModule is DebtIssuanceModule {
    
    /* ============ Constructor ============ */
    
    constructor(IController _controller) public DebtIssuanceModule(_controller) {}

    /* ============ Internal Functions ============ */
    
    /**
     * NOTE: Overrides DebtIssuanceModule#_resolveEquityPositions internal function.
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
                    SafeERC20.safeTransferFrom(
                        IERC20(component),
                        msg.sender,
                        address(_setToken),
                        componentQuantity
                    );
                    _validateATokenTransfer(_setToken, component, _quantity, _isIssue);

                    _executeExternalPositionHooks(_setToken, _quantity, IERC20(component), true, true);
                } else {
                    _executeExternalPositionHooks(_setToken, _quantity, IERC20(component), false, true);

                    Invoke.invokeTransfer(_setToken, component, _to, componentQuantity);

                    _validateATokenTransfer(_setToken, component, _quantity, _isIssue);
                }
            }
        }
    }

    /**
     * Validates the AToken transfer to/from SetToken during issuance/redemption. Reverts if Set is undercollateralized post transfer.
     *
     * @param _setToken         Instance of the SetToken being issued/redeemed
     * @param _component        Address of component being transferred in/out
     * @param _quantity         Total SetToken quantity with/net fees being issued/redeemed
     * @param _isIssue          True if issuing SetToken, false if redeeming
     */
    function _validateATokenTransfer(ISetToken _setToken, address _component, uint256 _quantity, bool _isIssue) internal {
        
        uint256 newComponentBalance = IERC20(_component).balanceOf(address(_setToken));    

        uint256 positionUnit = _setToken.getDefaultPositionRealUnit(address(_component)).toUint256();   
        uint256 newTotalSupply = _isIssue
            ? _setToken.totalSupply().add(_quantity)    // Mint happens after this function is called
            : _setToken.totalSupply();      // Burn takes place before this function is called
        
        require(
            newComponentBalance >= newTotalSupply.preciseMul(positionUnit),
            "Invalid transfer. Results in undercollateralization"
        );
    }
}