/*
    Copyright 2022 Set Labs Inc.

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
pragma solidity 0.6.12;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract ERC20ReturnFalseMock is ERC20 {
    constructor(
        string memory _name,
        string memory _symbol,
        uint8 _decimals
    )
        public
        ERC20(_name, _symbol)
    {
        _setupDecimals(_decimals);
    }

    function transfer(address, uint256) public override returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) public override returns (bool) {
        return false;
    }

    function approve(address, uint256) public override returns (bool) {
        return false;
    }
}
