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

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";

import { ISetToken } from "../../interfaces/ISetToken.sol";
import { PreciseUnitMath } from "../../lib/PreciseUnitMath.sol";


/**
 * @title ComponentPositions
 * @author Set Protocol
 */
library ComponentPositions {
    using SafeCast for uint256;
    using SafeMath for uint256;
    using SafeCast for int256;
    using SignedSafeMath for int256;
    using PreciseUnitMath for uint256;

    /* ============ Helper ============ */

        /**
     * Gets the total number of positions, defined as the following:
     * - Each component has a default position if its virtual unit is > 0
     * - Each component's external positions module is counted as a position
     */
    function getPositionCount(ISetToken.ComponentPositions storage _componentPositions) external view returns (uint256) {
        uint256 positionCount;
        for (uint256 i = 0; i < _componentPositions.components.length; i++) {
            address component = _componentPositions.components[i];

            // Increment the position count if the default position is > 0
            if (_componentPositions.componentPositions[component].virtualUnit > 0) {
                positionCount++;
            }

            // Increment the position count by each external position module
            address[] memory externalModules = _componentPositions.componentPositions[component].externalPositionModules;
            if (externalModules.length > 0) {
                positionCount = positionCount.add(externalModules.length);  
            }
        }

        return positionCount;
    }

    /**
     * Get enter markets calldata from SetToken
     */
    function getEnterMarketsCalldata(
        address _cToken,
        address _comptroller
    )
        public
        pure
        returns (address, uint256, bytes memory)
    {
        address[] memory marketsToEnter = new address[](1);
        marketsToEnter[0] = _cToken;

        // Compound's enter market function signature is: enterMarkets(address[] _cTokens)
        bytes memory callData = abi.encodeWithSignature("enterMarkets(address[])", marketsToEnter);

        return (_comptroller, 0, callData);
    }

}
