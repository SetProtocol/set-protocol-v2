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

import { Address } from "../../external/contracts/openzeppelin/utils/Address.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";

import { IController } from "../interfaces/IController.sol";
import { IModule } from "../interfaces/IModule.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { Position } from "./lib/Position.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";
import { AddressArrayUtils } from "../lib/AddressArrayUtils.sol";
import { SetTokenInternalUtils } from "./lib/SetTokenInternalUtils.sol";

/**
 * @title SetToken
 * @author Set Protocol
 *
 * ERC20 Token contract that allows privileged modules to make modifications to its positions and invoke function calls
 * from the SetToken.
 */
contract SetToken is ERC20 {
    using SafeMath for uint256;
    using SafeCast for int256;
    using SafeCast for uint256;
    using SignedSafeMath for int256;
    using PreciseUnitMath for int256;
    using Address for address;
    using AddressArrayUtils for address[];

    /* ============ Events ============ */

    // Removing events leaves us w/ a .7kb margin

    event Invoked(address indexed _target, uint indexed _value, bytes _data, bytes _returnValue);
    event ModuleAdded(address indexed _module);
    event ModuleRemoved(address indexed _module);
    event ModuleInitialized(address indexed _module);
    event ManagerEdited(address _newManager, address _oldManager);
    // event PendingModuleRemoved(address indexed _module);
    event PositionMultiplierEdited(int256 _newMultiplier);
    event ComponentAdded(address indexed _component);
    event ComponentRemoved(address indexed _component);
    event DefaultPositionUnitEdited(address indexed _component, int256 _realUnit);
    // event ExternalPositionUnitEdited(address indexed _component, address indexed _positionModule, int256 _realUnit);
    // event ExternalPositionDataEdited(address indexed _component, address indexed _positionModule, bytes _data);
    // event PositionModuleAdded(address indexed _component, address indexed _positionModule);
    // event PositionModuleRemoved(address indexed _component, address indexed _positionModule);

    /* ============ Modifiers ============ */

    /**
     * Throws if the sender is not a SetToken's module or module not enabled
     */
    modifier onlyModule() {
        // Internal function used to reduce bytecode size
        _validateOnlyModule();
        _;
    }

    /**
     * Throws if the sender is not the SetToken's manager
     */
    modifier onlyManager() {
        _validateOnlyManager();
        _;
    }

    /**
     * Throws if SetToken is locked and called by any account other than the locker.
     */
    modifier whenLockedOnlyLocker() {
        _validateWhenLockedOnlyLocker();
        _;
    }

    /* ============ State Variables ============ */

    // Address of the controller
    IController public controller;

    // The manager has the privelege to add modules, remove, and set a new manager
    address public manager;

    // A module that has locked other modules from privileged functionality, typically required
    // for multi-block module actions such as auctions
    address public locker;

    // List of initialized Modules; Modules extend the functionality of SetTokens
    address[] public modules;

    // Modules are initialized from NONE -> PENDING -> INITIALIZED through the
    // addModule (called by manager) and initialize  (called by module) functions
    mapping(address => ISetToken.ModuleState) public moduleStates;

    // When locked, only the locker (a module) can call privileged functionality
    // Typically utilized if a module (e.g. Auction) needs multiple transactions to complete an action
    // without interruption
    bool public isLocked;

    // List of components
    address[] public components;

    // Mapping that stores all Default and External position information for a given component.
    // Position quantities are represented as virtual units; Default positions are on the top-level,
    // while external positions are stored in a module array and accessed through its externalPositions mapping
    mapping(address => ISetToken.ComponentPosition) private componentPositions;

    // The multiplier applied to the virtual position unit to achieve the real/actual unit.
    // This multiplier is used for efficiently modifying the entire position units (e.g. streaming fee)
    int256 public positionMultiplier;

    /* ============ Constructor ============ */

    /**
     * When a new SetToken is created, initializes Positions in default state and adds modules into pending state.
     * All parameter validations are on the SetTokenCreator contract. Validations are performed already on the
     * SetTokenCreator. Initiates the positionMultiplier as 1e18 (no adjustments).
     *
     * @param _components             List of addresses of components for initial Positions
     * @param _units                  List of units. Each unit is the # of components per 10^18 of a SetToken
     * @param _modules                List of modules to enable. All modules must be approved by the Controller
     * @param _controller             Address of the controller
     * @param _manager                Address of the manager
     * @param _name                   Name of the SetToken
     * @param _symbol                 Symbol of the SetToken
     */
    constructor(
        address[] memory _components,
        int256[] memory _units,
        address[] memory _modules,
        IController _controller,
        address _manager,
        string memory _name,
        string memory _symbol
    )
        public
        ERC20(_name, _symbol)
    {
        controller = _controller;
        manager = _manager;
        positionMultiplier = PreciseUnitMath.preciseUnitInt();
        components = _components;

        // Modules are put in PENDING state, as they need to be individually initialized by the Module
        for (uint256 i = 0; i < _modules.length; i++) {
            moduleStates[_modules[i]] = ISetToken.ModuleState.PENDING;
        }

        // Positions are put in default state initially
        for (uint256 j = 0; j < _components.length; j++) {
            componentPositions[_components[j]].virtualUnit = _units[j];
        }
    }

    /* ============ External Functions ============ */

    /**
     * PRIVELEGED MODULE FUNCTION. Low level function that allows a module to make an arbitrary function
     * call to any contract.
     *
     * @param _target                 Address of the smart contract to call
     * @param _value                  Quantity of Ether to provide the call (typically 0)
     * @param _data                   Encoded function selector and arguments
     * @return _returnValue           Bytes encoded return value
     */
    function invoke(
        address _target,
        uint256 _value,
        bytes calldata _data
    )
        external
        onlyModule
        whenLockedOnlyLocker
        returns (bytes memory _returnValue)
    {
        _returnValue = _target.functionCallWithValue(_data, _value);

        emit  Invoked(_target, _value, _data, _returnValue);

        return _returnValue;
    }

    /**
     * PRIVELEGED MODULE FUNCTION. Low level function that adds a component to the components array.
     */
    function addComponent(address _component) external onlyModule whenLockedOnlyLocker {
        require(!components.contains(_component), "Must not be component");

        components.push(_component);

        emit  ComponentAdded(_component);
    }

    /**
     * PRIVELEGED MODULE FUNCTION. Low level function that removes a component from the components array.
     */
    function removeComponent(address _component) external onlyModule whenLockedOnlyLocker {
        components.removeStorage(_component);

        emit  ComponentRemoved(_component);
    }

    /**
     * PRIVELEGED MODULE FUNCTION. Low level function that edits a component's virtual unit. Takes a real unit
     * and converts it to virtual before committing.
     */
    function editDefaultPositionUnit(address _component, int256 _realUnit) external onlyModule whenLockedOnlyLocker {
        int256 virtualUnit = _convertRealToVirtualUnit(_realUnit);

        componentPositions[_component].virtualUnit = virtualUnit;

        emit  DefaultPositionUnitEdited(_component, _realUnit);
    }

    /**
     * PRIVELEGED MODULE FUNCTION. Low level function that adds a module to a component's externalPositionModules array
     */
    function addExternalPositionModule(address _component, address _positionModule) external onlyModule whenLockedOnlyLocker {
        require(!_externalPositionModules(_component).contains(_positionModule), "Module already added");

        componentPositions[_component].externalPositionModules.push(_positionModule);

        // emit  PositionModuleAdded(_component, _positionModule);
    }

    /**
     * PRIVELEGED MODULE FUNCTION. Low level function that removes a module from a component's
     * externalPositionModules array and deletes the associated externalPosition.
     */
    function removeExternalPositionModule(
        address _component,
        address _positionModule
    )
        external
        onlyModule
        whenLockedOnlyLocker
    {
        componentPositions[_component].externalPositionModules.removeStorage(_positionModule);

        delete componentPositions[_component].externalPositions[_positionModule];

        // emit  PositionModuleRemoved(_component, _positionModule);
    }

    /**
     * PRIVELEGED MODULE FUNCTION. Low level function that edits a component's external position virtual unit.
     * Takes a real unit and converts it to virtual before committing.
     */
    function editExternalPositionUnit(
        address _component,
        address _positionModule,
        int256 _realUnit
    )
        external
        onlyModule
        whenLockedOnlyLocker
    {
        int256 virtualUnit = _convertRealToVirtualUnit(_realUnit);

        componentPositions[_component].externalPositions[_positionModule].virtualUnit = virtualUnit;

        // emit  ExternalPositionUnitEdited(_component, _positionModule, _realUnit);
    }

    /**
     * PRIVELEGED MODULE FUNCTION. Low level function that edits a component's external position data
     */
    function editExternalPositionData(
        address _component,
        address _positionModule,
        bytes calldata _data
    )
        external
        onlyModule
        whenLockedOnlyLocker
    {
        componentPositions[_component].externalPositions[_positionModule].data = _data;

        // emit  ExternalPositionDataEdited(_component, _positionModule, _data);
    }

    /**
     * PRIVELEGED MODULE FUNCTION. Modifies the position multiplier. This is typically used to efficiently
     * update all the Positions' units at once in applications where inflation is awarded (e.g. subscription fees).
     */
    function editPositionMultiplier(int256 _newMultiplier) external onlyModule whenLockedOnlyLocker {
        SetTokenInternalUtils.validateNewMultiplier(address(this), _newMultiplier);

        positionMultiplier = _newMultiplier;

        emit  PositionMultiplierEdited(_newMultiplier);
    }

    /**
     * PRIVELEGED MODULE FUNCTION. Increases the "account" balance by the "quantity".
     */
    function mint(address _account, uint256 _quantity) external onlyModule whenLockedOnlyLocker {
        _mint(_account, _quantity);
    }

    /**
     * PRIVELEGED MODULE FUNCTION. Decreases the "account" balance by the "quantity".
     * _burn checks that the "account" already has the required "quantity".
     */
    function burn(address _account, uint256 _quantity) external onlyModule whenLockedOnlyLocker {
        _burn(_account, _quantity);
    }

    /**
     * PRIVELEGED MODULE FUNCTION. When a SetToken is locked, only the locker can call privileged functions.
     */
    function lock() external onlyModule {
        require(!isLocked, "Must not be locked");
        locker = msg.sender;
        isLocked = true;
    }

    /**
     * PRIVELEGED MODULE FUNCTION. Unlocks the SetToken and clears the locker
     */
    function unlock() external onlyModule {
        require(isLocked, "Must be locked");
        require(locker == msg.sender, "Must be locker");
        delete locker;
        isLocked = false;
    }

    /**
     * MANAGER ONLY. Adds a module into a PENDING state; Module must later be initialized via
     * module's initialize function
     */
    function addModule(address _module) external onlyManager {
        require(moduleStates[_module] == ISetToken.ModuleState.NONE, "Module must not be added");
        require(controller.isModule(_module), "Must be enabled on Controller");

        moduleStates[_module] = ISetToken.ModuleState.PENDING;

        emit  ModuleAdded(_module);
    }

    /**
     * MANAGER ONLY. Removes a module from the SetToken. SetToken calls removeModule on module itself to confirm
     * it is not needed to manage any remaining positions and to remove state.
     */
    function removeModule(address _module) external onlyManager {
        require(!isLocked, "Only when unlocked");
        require(moduleStates[_module] == ISetToken.ModuleState.INITIALIZED, "Module must be added");

        IModule(_module).removeModule();

        moduleStates[_module] = ISetToken.ModuleState.NONE;

        modules.removeStorage(_module);

        emit  ModuleRemoved(_module);
    }

    /**
     * MANAGER ONLY. Removes a pending module from the SetToken.
     */
    function removePendingModule(address _module) external onlyManager {
        require(!isLocked, "Only when unlocked");
        require(moduleStates[_module] == ISetToken.ModuleState.PENDING, "Module must be pending");

        moduleStates[_module] = ISetToken.ModuleState.NONE;

        // emit  PendingModuleRemoved(_module);
    }

    /**
     * Initializes an added module from PENDING to INITIALIZED state. Can only call when unlocked.
     * An address can only enter a PENDING state if it is an enabled module added by the manager.
     * Only callable by the module itself, hence msg.sender is the subject of update.
     */
    function initializeModule() external {
        require(!isLocked, "Only when unlocked");
        require(moduleStates[msg.sender] == ISetToken.ModuleState.PENDING, "Module must be pending");

        moduleStates[msg.sender] = ISetToken.ModuleState.INITIALIZED;
        modules.push(msg.sender);

        emit  ModuleInitialized(msg.sender);
    }

    /**
     * MANAGER ONLY. Changes manager; We allow null addresses in case the manager wishes to wind down the SetToken.
     * Modules may rely on the manager state, so only changable when unlocked
     */
    function setManager(address _manager) external onlyManager {
        require(!isLocked, "Only when unlocked");
        address oldManager = manager;
        manager = _manager;

        emit  ManagerEdited(_manager, oldManager);
    }

    receive() external payable {} // solium-disable-line quotes

    /* ============ Public Getter Functions ============ */
    function getComponents() external view returns (address[] memory) {
        return components;
    }

    function getModules() external view returns (address[] memory){
        return modules;
    }

    function getDefaultPositionVirtualUnit(address _component) public view returns (int256) {
        return componentPositions[_component].virtualUnit;
    }

    function getExternalPositionVirtualUnit(address _component, address _module) external view returns (int256) {
       return componentPositions[_component].externalPositions[_module].virtualUnit;
    }

    function getComponentExternalPosition(
        address _component,
        address _positionModule
    )
        external
        view
        returns (ISetToken.ExternalPosition memory)
    {
        return componentPositions[_component].externalPositions[_positionModule];
    }

    function getExternalPositionModules(address _component) external view returns(address[] memory) {
        return _externalPositionModules(_component);
    }

    function getExternalPositionData(address _component, address _positionModule) external view returns(bytes memory) {
        return _externalPositionData(_component, _positionModule);
    }

    /* ============ Internal Functions ============ */

    function _externalPositionModules(address _component) internal view returns(address[] memory) {
        return componentPositions[_component].externalPositionModules;
    }

    function _externalPositionVirtualUnit(address _component, address _module) internal view returns(int256) {
        return componentPositions[_component].externalPositions[_module].virtualUnit;
    }

    function _externalPositionData(address _component, address _module) internal view returns(bytes memory) {
        return componentPositions[_component].externalPositions[_module].data;
    }

    /**
     * Takes a real unit and divides by the position multiplier to return the virtual unit
     */
    function _convertRealToVirtualUnit(int256 _realUnit) internal view returns(int256) {
        int256 virtualUnit = _realUnit.conservativePreciseDiv(positionMultiplier);

        // These checks ensure that the virtual unit does not return a result that has rounded down to 0
        if (_realUnit > 0 && virtualUnit == 0) {
            revert("Virtual unit conversion invalid");
        }

        return virtualUnit;
    }

    /**
     * Takes a virtual unit and multiplies by the position multiplier to return the real unit
     */
    function _convertVirtualToRealUnit(int256 _virtualUnit) internal view returns(int256) {
        return _virtualUnit.conservativePreciseMul(positionMultiplier);
    }

    /**
     * Due to reason error bloat, internal functions are used to reduce bytecode size
     *
     * Module must be initialized on the SetToken and enabled by the controller
     */
    function _validateOnlyModule() internal view {
        require(
            moduleStates[msg.sender] == ISetToken.ModuleState.INITIALIZED,
            "Only the module can call"
        );

        require(
            controller.isModule(msg.sender),
            "Module must be enabled on controller"
        );
    }

    function _validateOnlyManager() internal view {
        require(msg.sender == manager, "Only manager can call");
    }

    function _validateWhenLockedOnlyLocker() internal view {
        if (isLocked) {
            require(msg.sender == locker, "Locked: only locker can call");
        }
    }
}
