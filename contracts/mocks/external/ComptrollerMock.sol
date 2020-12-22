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

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ICErc20 } from "../../interfaces/external/ICErc20.sol";

contract ComptrollerMock {
    address comp;
    uint256 compAmount;
    address setToken;
    ICErc20[] public allMarkets;

    constructor(address _comp, uint256 _compAmount, address _collateralCToken) public {
        comp = _comp;
        compAmount = _compAmount;
        allMarkets.push(ICErc20(_collateralCToken));
    }

    // Initialize SetToken address which will send/receive tokens for the trade
    function addSetTokenAddress(address _setToken) external {
        setToken = _setToken;
    }

    function setCompAmount(uint256 _compAmount) external {
        compAmount = _compAmount;
    }

    // Return empty array
    function getAllMarkets() public view returns (ICErc20[] memory) {
        return allMarkets;
    }

    // Return empty array
    function enterMarkets(address[] memory _cTokens) public returns (uint256[] memory) {
        return new uint256[](_cTokens.length);
    }

    function claimComp(address _holder) public {
        require(ERC20(comp).transfer(setToken, compAmount), "ERC20 transfer failed");

        // Used to silence compiler warnings
        _holder;
    }
}