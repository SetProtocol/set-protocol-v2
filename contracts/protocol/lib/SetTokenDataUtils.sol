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
 * @title SetTokenDataUtils
 * @author Set Protocol
 *
 * Getters and status methods for contracts interacting with SetToken, packaged as an externally
 * linked library to reduce contract size.
 */
library SetTokenDataUtils {
    using SafeMath for uint256;
    using SafeCast for int256;
    using SafeCast for uint256;
    using SignedSafeMath for int256;
    using PreciseUnitMath for int256;
    using Address for address;
    using AddressArrayUtils for address[];

    /* ============ Constants ============ */

    /*
        The PositionState is the status of the Position, whether it is Default (held on the SetToken)
        or otherwise held on a separate smart contract (whether a module or external source).
        There are issues with cross-usage of enums, so we are defining position states
        as a uint8.
    */
    uint8 internal constant DEFAULT = 0;
    uint8 internal constant EXTERNAL = 1;

    /* ============ Public Getter Functions ============ */

    function getDefaultPositionRealUnit(ISetToken _setToken, address _component) public view returns(int256) {
        int256 virtualUnit = _setToken.getDefaultPositionVirtualUnit(_component);
        return _convertVirtualToRealUnit(_setToken, virtualUnit);
    }

    function getDefaultPositionRealUnit(address _setToken, address _component) public view returns(int256) {
        int256 virtualUnit = ISetToken(_setToken).getDefaultPositionVirtualUnit(_component);
        return _convertVirtualToRealUnit(ISetToken(_setToken), virtualUnit);
    }

    function getExternalPositionRealUnit(
        ISetToken _setToken,
        address _component,
        address _positionModule
    )
        public
        view
        returns(int256)
    {

        int256 virtualUnit = ISetToken(_setToken).getComponentExternalPosition(_component, _positionModule).virtualUnit;
        return _convertVirtualToRealUnit(ISetToken(_setToken), virtualUnit);
    }

    function getExternalPositionRealUnit(
        address _setToken,
        address _component,
        address _positionModule
    )
        public
        view
        returns(int256)
    {

        int256 virtualUnit = ISetToken(_setToken).getComponentExternalPosition(_component, _positionModule).virtualUnit;
        return _convertVirtualToRealUnit(ISetToken(_setToken), virtualUnit);
    }

    /**
     * Returns the total Real Units for a given component, summing the default and public position units.
     */
    function getTotalComponentRealUnits(
        address _setToken,
        address _component
    )
        public
        view
        returns(int256)
    {
        int256 totalUnits = getDefaultPositionRealUnit(ISetToken(_setToken), _component);

        address[] memory externalModules = ISetToken(_setToken).getExternalPositionModules(_component);
        for (uint256 i = 0; i < externalModules.length; i++) {
            // We will perform the summation no matter what, as an external position virtual unit can be negative
            totalUnits = totalUnits.add(
                getExternalPositionRealUnit(ISetToken(_setToken), _component, externalModules[i])
            );
        }

        return totalUnits;
    }

    /**
     * Only ModuleStates of INITIALIZED modules are considered enabled
     */
    function isInitializedModule(ISetToken _setToken, address _module) external view returns (bool) {
        return _setToken.moduleStates(_module) == ISetToken.ModuleState.INITIALIZED;
    }

    function isInitializedModule(address _setToken, address _module) external view returns (bool) {
        return ISetToken(_setToken).moduleStates(_module) == ISetToken.ModuleState.INITIALIZED;
    }

    /**
     * Returns whether the module is in a pending state
     */
    function isPendingModule(ISetToken _setToken, address _module) external view returns (bool) {
        return _setToken.moduleStates(_module) == ISetToken.ModuleState.PENDING;
    }

    function isComponent(ISetToken _setToken, address _component) public view returns(bool) {
        return _setToken.getComponents().contains(_component);
    }

    function isExternalPositionModule(
        ISetToken _setToken,
        address _component,
        address _module
    )
        public
        view
        returns(bool)
    {
        return _setToken.getExternalPositionModules(_component).contains(_module);
    }

    /**
     * Returns a list of Positions, through traversing the components. Each component with a non-zero virtual unit
     * is considered a Default Position, and each externalPositionModule will generate a unique position.
     * Virtual units are converted to real units. This function is typically used off-chain for data presentation purposes.
     */
    function getPositions(address _setToken) public view returns (ISetToken.Position[] memory) {
        ISetToken.Position[] memory positions = new ISetToken.Position[](
            _getPositionCount(ISetToken(_setToken))
        );
        uint256 positionCount = 0;
        address[] memory components = ISetToken(_setToken).getComponents();

        for (uint256 i = 0; i < components.length; i++) {
            address component = components[i];

            // A default position exists if the default virtual unit is > 0
            if (ISetToken(_setToken).getDefaultPositionVirtualUnit(component) > 0) {
                positions[positionCount] = ISetToken.Position({
                    component: component,
                    module: address(0),
                    unit: getDefaultPositionRealUnit(ISetToken(_setToken), component),
                    positionState: DEFAULT,
                    data: ""
                });

                positionCount++;
            }

            address[] memory externalModules = ISetToken(_setToken).getExternalPositionModules(component);
            for (uint256 j = 0; j < externalModules.length; j++) {
                address currentModule = externalModules[j];

                positions[positionCount] = ISetToken.Position({
                    component: component,
                    module: currentModule,
                    unit: getExternalPositionRealUnit(ISetToken(_setToken), component, currentModule),
                    positionState: EXTERNAL,
                    data: ISetToken(_setToken).getExternalPositionData(component, currentModule)
                });

                positionCount++;
            }
        }

        return positions;
    }

    /**
     * Takes a virtual unit and multiplies by the position multiplier to return the real unit
     */
    function _convertVirtualToRealUnit(ISetToken _setToken, int256 _virtualUnit) internal view returns(int256) {
        return _virtualUnit.conservativePreciseMul(_setToken.positionMultiplier());
    }

    /**
     * Gets the total number of positions, defined as the following:
     * - Each component has a default position if its virtual unit is > 0
     * - Each component's external positions module is counted as a position
     */
    function _getPositionCount(ISetToken _setToken) internal view returns (uint256) {
        uint256 positionCount;
        address[] memory components = _setToken.getComponents();

        for (uint256 i = 0; i < components.length; i++) {
            address component = components[i];

            // Increment the position count if the default position is > 0
            if (_setToken.getDefaultPositionVirtualUnit(component) > 0) {
                positionCount++;
            }

            // Increment the position count by each external position module
            uint256 externalModulesLength = _setToken.getExternalPositionModules(component).length;
            if (externalModulesLength > 0) {
                positionCount = positionCount.add(externalModulesLength);
            }
        }

        return positionCount;
    }
}
