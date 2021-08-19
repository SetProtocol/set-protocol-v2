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

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { ISetToken } from "../../interfaces/ISetToken.sol";
import { PreciseUnitMath } from "../../lib/PreciseUnitMath.sol";


/**
 * @title IssuanceUtils
 * @author Set Protocol
 *
 * A collection of utility functions to help during issuance/redemption of SetToken.
 */
library IssuanceUtils {
    using SafeMath for uint256;
    using SafeCast for int256;
    using PreciseUnitMath for uint256;

    /**
     * Validates the component token transfer to/from SetToken during issuance/redemption. Reverts if Set is undercollateralized post transfer.
     *
     * @param _setToken         Instance of the SetToken being issued/redeemed
     * @param _component        Address of component being transferred in/out
     * @param _isIssue          True if issuing SetToken, false if redeeming
     * @param _issueQuantity    Total SetToken issue quantity with fees. Pass 0 if Set is being redeemed.
     */
    function validateComponentTransfer(ISetToken _setToken, address _component, bool _isIssue, uint256 _issueQuantity) internal {
        
        uint256 newComponentBalance = IERC20(_component).balanceOf(address(_setToken));    

        uint256 positionUnit = _setToken.getDefaultPositionRealUnit(address(_component)).toUint256();   
        uint256 newTotalSupply = _isIssue
            ? _setToken.totalSupply().add(_issueQuantity)    // Mint happens after this function is called
            : _setToken.totalSupply();                  // Burn takes place before this function is called
        
        require(
            newComponentBalance >= newTotalSupply.preciseMul(positionUnit),
            "Invalid transfer. Results in undercollateralization"
        );
    }
}