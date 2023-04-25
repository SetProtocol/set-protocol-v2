/*
    Copyright 2023 Set Labs Inc.

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

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { IController } from "../interfaces/IController.sol";

contract TokenEnabler is Ownable {

    IController public immutable controller;
    address[] public tokensToEnable;

    /* ============ Constructor ============ */

    constructor(
        IController _controller,
        address[] memory _tokensToEnable
    )
        public
        Ownable()
    {
        controller = _controller;
        tokensToEnable = _tokensToEnable;
    }

    /* ============ External Functions ============ */

    /**
     * ONLY OWNER: Enables tokens on the controller
     */
    function enableTokens() external onlyOwner {
        for (uint256 i = 0; i < tokensToEnable.length; i++) {
            controller.addSet(tokensToEnable[i]);
        }
    }

    /* ============ View Functions ============ */

    function getTokensToEnable() external view returns(address[] memory) {
        return tokensToEnable;
    }
}
