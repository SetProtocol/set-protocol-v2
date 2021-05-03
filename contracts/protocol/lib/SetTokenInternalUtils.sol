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

pragma solidity 0.6.12;
pragma experimental "ABIEncoderV2";

import { Address } from "../../../external/contracts/openzeppelin/utils/Address.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";

import { IController } from "../../interfaces/IController.sol";
import { IModule } from "../../interfaces/IModule.sol";
import { ISetToken } from "../../interfaces/ISetToken.sol";
import { Position } from "../lib/Position.sol";
import { PreciseUnitMath } from "../../lib/PreciseUnitMath.sol";
import { AddressArrayUtils } from "../../lib/AddressArrayUtils.sol";


/**
 * @title SetTokenInternalUtils
 * @author Set Protocol
 *
 * Utilities SetToken can invoke on itself. These are located an externally linked library to
 * reduce contract size.
 */
library SetTokenInternalUtils {
    using SafeMath for uint256;
    using SafeCast for int256;
    using SafeCast for uint256;
    using SignedSafeMath for int256;
    using PreciseUnitMath for int256;
    using Address for address;
    using AddressArrayUtils for address[];

    /**
     * To prevent virtual to real unit conversion issues (where real unit may be 0), the
     * product of the positionMultiplier and the lowest absolute virtualUnit value (across default and
     * external positions) must be greater than 0.
     */
    function validateNewMultiplier(address _setToken, int256 _newMultiplier) external view {
        int256 minVirtualUnit = _getPositionsAbsMinimumVirtualUnit(ISetToken(_setToken));

        require(minVirtualUnit.conservativePreciseMul(_newMultiplier) > 0, "New multiplier too small");
    }

    /**
     * Loops through all of the positions and returns the smallest absolute value of
     * the virtualUnit.
     *
     * @return Min virtual unit across positions denominated as int256
     */
    function _getPositionsAbsMinimumVirtualUnit(ISetToken _setToken) internal view returns(int256) {
        // Additional assignment happens in the loop below
        uint256 minimumUnit = uint256(-1);
        address[] memory components = _setToken.getComponents();

        for (uint256 i = 0; i < components.length; i++) {
            address component = components[i];

            // A default position exists if the default virtual unit is > 0
            uint256 defaultUnit = _setToken.getDefaultPositionVirtualUnit(component).toUint256();
            if (defaultUnit > 0 && defaultUnit < minimumUnit) {
                minimumUnit = defaultUnit;
            }

            address[] memory externalModules = _setToken.getExternalPositionModules(component);
            for (uint256 j = 0; j < externalModules.length; j++) {
                address currentModule = externalModules[j];

                uint256 virtualUnit = _absoluteValue(
                    _setToken.getExternalPositionVirtualUnit(component, currentModule)
                );
                if (virtualUnit > 0 && virtualUnit < minimumUnit) {
                    minimumUnit = virtualUnit;
                }
            }
        }

        return minimumUnit.toInt256();
    }

    /**
     * Returns the absolute value of the signed integer value
     * @param _a Signed interger value
     * @return Returns the absolute value in uint256
     */
    function _absoluteValue(int256 _a) internal pure returns(uint256) {
        return _a >= 0 ? _a.toUint256() : (-_a).toUint256();
    }
}
