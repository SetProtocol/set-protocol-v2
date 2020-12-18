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


import { ISetToken } from "../interfaces/ISetToken.sol";
import "@nomiclabs/buidler/console.sol";


/**
 * @title SetTokenViewer
 * @author Set Protocol
 *
 * SetTokenViewer enables batch queries of SetToken state.
 */
contract SetTokenViewer {

    function batchFetchManagers(ISetToken[] memory _setTokens) external view returns (address[] memory) {
        address[] memory managers = new address[](_setTokens.length);

        for (uint256 i = 0; i < _setTokens.length; i++) {
            managers[i] = _setTokens[i].manager();
        }
        return managers;
    }

    function batchFetchModuleStates(
        ISetToken[] calldata _setTokens,
        address[] calldata _modules
    )
        external
        view
        returns (ISetToken.ModuleState[][] memory)
    {
        ISetToken.ModuleState[][] memory states = new ISetToken.ModuleState[][](_setTokens.length);
        for (uint256 i = 0; i < _setTokens.length; i++) {
            ISetToken.ModuleState[] memory moduleStates = new ISetToken.ModuleState[](_modules.length);
            for (uint256 j = 0; j < _modules.length; j++) {
                moduleStates[j] = _setTokens[i].moduleStates(_modules[j]);
            }
            states[i] = moduleStates;
        }
        return states;
    }
}