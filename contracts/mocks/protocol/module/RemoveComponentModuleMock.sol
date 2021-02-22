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

import { IController } from "../../../interfaces/IController.sol";
import { ISetToken } from "../../../interfaces/ISetToken.sol";
import { RemoveComponentModule } from "../../../protocol/modules/RemoveComponentModule.sol";


/**
 * @title RemoveComponentModuleMock
 * @author Set Protocol
 *
 * Mock of RemoveComponentModule that allows easy addition of component to components array.
 */
contract RemoveComponentModuleMock is RemoveComponentModule {

    /**
     * CONSTRUCTOR: Pass in the setToken intended to be modified and the component being removed.
     *
     * @param _setToken                 Address of SetToken contract
     * @param _component                Address of duplicate token being removed
     */
    constructor(
        IController _controller,
        ISetToken _setToken,
        address _component
    )
        public
        RemoveComponentModule(_controller, _setToken, _component)
    {}

    function addComponent() external {
        setToken.addComponent(component);
    }
}