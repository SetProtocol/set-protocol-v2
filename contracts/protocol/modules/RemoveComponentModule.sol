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

import { IController } from "../../interfaces/IController.sol";
import { ISetToken } from "../../interfaces/ISetToken.sol";
import { ModuleBase } from "../lib/ModuleBase.sol";


/**
 * @title RemoveComponentModule
 * @author Set Protocol
 *
 * Single use module to remove duplicated component from array.
 */
contract RemoveComponentModule is ModuleBase {

    /* ============ State ============ */
    
    ISetToken public setToken;
    address public component;
    bool public used;

    /**
     * CONSTRUCTOR: Pass in the setToken intended to be modified and the component being removed.
     *
     * @param _setToken                 Address of SetToken contract
     * @param _component                Address of duplicate token being removed
     */
    constructor(IController _controller, ISetToken _setToken, address _component) public ModuleBase(_controller) {
        setToken = _setToken;
        component = _component;
    }

    /**
     * ONLY MANAGER: Remove stored component from array. Checks to see if there's a duplicate component and
     * that module has not been previously used. Calls remove component which will remove first instance
     * of component in the array and set used to true to make sure removeComponent() cannot be called again.
     */
    function removeComponent() external onlyManagerAndValidSet(setToken) {
        require(!used, "Module has been used");

        address[] memory components = setToken.getComponents();
        uint256 componentCount;
        for (uint256 i = 0; i < components.length; i++) {
            if (component == components[i]) {
                componentCount = componentCount.add(1);
            }
        }
        require(componentCount > 1, "Component does not have duplicate");

        setToken.removeComponent(component);

        used = true;
    }

    /**
     * ONLY MANAGER: Initializes module on the SetToken.
     */
    function initialize()
        external
        onlySetManager(setToken, msg.sender)
        onlyValidAndPendingSet(setToken)
    {
        setToken.initializeModule();
    }

    /**
     * ONLY SET TOKEN: Removes module from SetToken.
     */
    function removeModule() external override {
        require(msg.sender == address(setToken), "Caller must be SetToken");
    }
}