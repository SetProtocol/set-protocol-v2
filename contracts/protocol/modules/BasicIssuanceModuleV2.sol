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

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { BasicIssuanceModule } from "../../protocol/modules/BasicIssuanceModule.sol";
import { IController } from "../../interfaces/IController.sol";
import { IManagerIssuanceHook } from "../../interfaces/IManagerIssuanceHook.sol";
import { Invoke } from "../lib/Invoke.sol";
import { ISetToken } from "../../interfaces/ISetToken.sol";
import { Position } from "../lib/Position.sol";
import { PreciseUnitMath } from "../../lib/PreciseUnitMath.sol";

/**
 * @title BasicIssuanceModuleV2
 * @author Set Protocol
 *
 * Module that enables issuance and redemption functionality on a SetToken. This is a module that is
 * required to bring the totalSupply of a Set above 0.
 */
contract BasicIssuanceModuleV2 is BasicIssuanceModule {
    using Invoke for ISetToken;
    using Position for ISetToken.Position;
    using Position for ISetToken;
    using PreciseUnitMath for uint256;
    using SafeMath for uint256;
    using SafeCast for int256;

    /* ============ Constructor ============ */

    /**
     * Set state controller state variable
     *
     * @param _controller             Address of controller contract
     */
    constructor(IController _controller) public BasicIssuanceModule(_controller) {}

    /* ============ External Functions ============ */

    /**
     * Redeems the SetToken's positions and sends the components of the given
     * quantity to the caller. This function only handles Default Positions (positionState = 0).
     *
     * @param _setToken             Instance of the SetToken contract
     * @param _quantity             Quantity of the SetToken to redeem
     * @param _to                   Address to send component assets to
     */
    function redeem(
        ISetToken _setToken,
        uint256 _quantity,
        address _to
    )
        external
        override
        nonReentrant
        onlyValidAndInitializedSet(_setToken)
    {
        require(_quantity > 0, "Redeem quantity must be > 0");

        address hookContract = _callPreRedeemHooks(_setToken, _quantity, msg.sender, _to);

        // Burn the SetToken - ERC20's internal burn already checks that the user has enough balance
        _setToken.burn(msg.sender, _quantity);

        // For each position, invoke the SetToken to transfer the tokens to the user
        address[] memory components = _setToken.getComponents();
        for (uint256 i = 0; i < components.length; i++) {
            address component = components[i];
            require(!_setToken.hasExternalPosition(component), "Only default positions are supported");

            uint256 unit = _setToken.getDefaultPositionRealUnit(component).toUint256();

            // Use preciseMul to round down to ensure overcollateration when small redeem quantities are provided
            uint256 componentQuantity = _quantity.preciseMul(unit);

            // Instruct the SetToken to transfer the component to the user
            _setToken.strictInvokeTransfer(
                component,
                _to,
                componentQuantity
            );
        }

        emit SetTokenRedeemed(address(_setToken), msg.sender, _to, hookContract, _quantity);
    }

    /**
     * SET TOKEN ONLY: Allows removal (and deletion of state) of BasicIssuanceModuleV2
     */
    function removeModule() external override {
        delete managerIssuanceHook[ISetToken(msg.sender)];
    }

    /**
     * MANAGER ONLY: Updates the address of the manager issuance hook. To remove the hook
     * set the new hook address to address(0)
     *
     * @param _setToken         Instance of the SetToken to update manager hook
     * @param _newHook          New manager hook contract address
     */
    function updateManagerIssuanceHook(
        ISetToken _setToken,
        IManagerIssuanceHook _newHook
    )
        external
        onlySetManager(_setToken, msg.sender)
        onlyValidAndInitializedSet(_setToken)
    {
        managerIssuanceHook[_setToken] = _newHook;
    }

    /* ============ Internal Functions ============ */

    /**
     * If a pre-issue hook has been configured, call the external-protocol contract's pre-redeem function.
     * Pre-issue hook logic can contain arbitrary logic including validations, external function calls, etc.
     */
    function _callPreRedeemHooks(
        ISetToken _setToken,
        uint256 _quantity,
        address _caller,
        address _to
    )
        internal
        returns(address)
    {
        IManagerIssuanceHook preIssueHook = managerIssuanceHook[_setToken];
        if (address(preIssueHook) != address(0)) {
            preIssueHook.invokePreRedeemHook(_setToken, _quantity, _caller, _to);
            return address(preIssueHook);
        }

        return address(0);
    }
}