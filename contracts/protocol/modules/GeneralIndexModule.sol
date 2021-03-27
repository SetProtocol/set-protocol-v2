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
import { Math } from "@openzeppelin/contracts/math/Math.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { AddressArrayUtils } from "../../lib/AddressArrayUtils.sol";
import { IController } from "../../interfaces/IController.sol";
import { IExchangeAdapter } from "../../interfaces/IExchangeAdapter.sol";
import { Invoke } from "../lib/Invoke.sol";
import { ISetToken } from "../../interfaces/ISetToken.sol";
import { IWETH } from "../../interfaces/external/IWETH.sol";
import { ModuleBase } from "../lib/ModuleBase.sol";
import { Position } from "../lib/Position.sol";
import { PreciseUnitMath } from "../../lib/PreciseUnitMath.sol";
import { Uint256ArrayUtils } from "../../lib/Uint256ArrayUtils.sol";


/**
 * @title GeneralIndexModule
 * @author Set Protocol
 *
 * Smart contract that facilitates rebalances for indices. Manager can set target unit amounts, max trade sizes, the
 * exchange to trade on, and the cool down period between trades (on a per asset basis). 
 *
 * SECURITY ASSUMPTION:
 *  - Works with following modules: StreamingFeeModule, BasicIssuanceModule (any other module additions to Sets using
      this module need to be examined separately)
 */
contract GeneralIndexModule is ModuleBase, ReentrancyGuard {
    using SafeCast for int256;
    using SafeCast for uint256;
    using SafeMath for uint256;
    using Position for uint256;
    using Math for uint256;
    using Position for ISetToken;
    using Invoke for ISetToken;
    using AddressArrayUtils for address[];
    using Uint256ArrayUtils for uint256[];

    /* ============ Struct ============ */

    struct TradeExecutionParams {
        uint256 targetUnit;              // Target unit of component for Set
        uint256 maxSize;                 // Max trade size in precise units
        uint256 coolOffPeriod;           // Required time between trades for the asset
        uint256 lastTradeTimestamp;      // Timestamp of last trade
        string exchange;                 // Name of exchange adapter
    }

    struct TradePermissionInfo {
        bool anyoneTrade;                               // Boolean indicating if anyone can execute a trade
        mapping(address => bool) tradeAllowList;        // Mapping indicating which addresses are allowed to execute trade
    }

    struct RebalanceInfo {
        uint256 positionMultiplier;         // Position multiplier at the beginning of rebalance
        uint256 raiseTargetPercentage;      // Amount to raise all unit targets by if allowed (in precise units)
        address[] rebalanceComponents;      // Array of components involved in rebalance
    }

    // todo: we are comparing them everywhere, we can instead store sendToken and ReceiveToken
    struct TradeInfo {
        ISetToken setToken;                     // Instance of SetToken
        IExchangeAdapter exchangeAdapter;       // Instance of Exchange Adapter
        address fixedQuantityToken;             // Address of token having fixed quantity traded
        address floatingQuantityToken;          // Address of token having floating quantity traded
        bool isSendTokenFixed;                  // Boolean indicating fixed asset is send token
        uint256 setTotalSupply;                 // Total supply of Set (in precise units)
        uint256 totalFixedQuantity;             // Total quanity of fixed asset being traded
        uint256 preTradeFixedBalance;           // Total initial balance of fixed quantity token
        uint256 preTradeFloatingBalance;        // Total initial balance of floating quantity token
    }

    /* ============ Events ============ */

    event TargetUnitsUpdated(ISetToken indexed _setToken, address indexed _component, uint256 _newUnit, uint256 _positionMultiplier);
    event TradeMaximumUpdated(ISetToken indexed _setToken, address indexed _component, uint256 _newMaximum);
    event AssetExchangeUpdated(ISetToken indexed _setToken, address indexed _component, uint256 _newExchange);
    event CoolOffPeriodUpdated(ISetToken indexed _setToken, address indexed _component, uint256 _newCoolOffPeriod);
    event TraderStatusUpdated(ISetToken indexed _setToken, address indexed _trader, bool _status);
    event AnyoneTradeUpdated(ISetToken indexed _setToken, bool indexed _status);
    event TradeExecuted(
        ISetToken indexed _setToken,
        address indexed _sellComponent,
        address indexed _buyComponent,
        IExchangeAdapter _exchangeAdapter,
        address _executor,
        uint256 _amountSold,
        uint256 _amountBought
    );

    /* ============ State Variables ============ */

    mapping(ISetToken => mapping(IERC20 => TradeExecutionParams)) public executionInfo;     // Mapping of SetToken to execution parameters of each asset on SetToken
    mapping(ISetToken => TradePermissionInfo) public permissionInfo;                        // Mapping of SetToken to trading permissions
    mapping(ISetToken => RebalanceInfo) public rebalanceInfo;                               // Mapping of SetToken to relevant data for current rebalance
    IWETH public weth;                                                                      // Weth contract address
    
    /* ============ Modifiers ============ */

    modifier onlyAllowedTraderF(address _caller, address _setToken) {
        require(_isAllowedTrader(_caller, _setToken), "Address not permitted to trade");
        _;
    }

    modifier onlyEOA() {
        require(msg.sender == tx.origin, "Caller must be EOA Address");
        _;
    }

    /* ============ Constructor ============ */

    constructor(IController _controller, IWETH _weth) public ModuleBase(_controller) {
        weth = _weth;
    }

    /* ============ External Functions ============ */

    function startRebalance(
        ISetToken _setToken,
        address[] calldata _newComponents,
        uint256[] calldata _newComponentsTargetUnits,
        uint256[] calldata _oldComponentsTargetUnits,
        uint256 _positionMultiplier
    )
        external
        onlyManagerAndValidSet(_setToken)
    {
        // Don't use validate arrays because empty arrays are valid
        require(_newComponents.length == _newComponentsTargetUnits.length, "Array length mismatch");

        address[] memory currentComponents = _setToken.getComponents();
        require(currentComponents.length == _oldComponentsTargetUnits.length, "New allocation must have target for all old components");

        address[] memory aggregateComponents = currentComponents.extend(_newComponents);
        uint256[] memory aggregateTargetUnits = _oldComponentsTargetUnits.extend(_newComponentsTargetUnits);

        require(!aggregateComponents.hasDuplicate(), "Cannot duplicate components");

        for (uint256 i = 0; i < aggregateComponents.length; i++) {
            address component = aggregateComponents[i];
            uint256 targetUnit = aggregateTargetUnits[i];

            executionInfo[_setToken][component].targetUnit = targetUnit;

            emit TargetUnitsUpdated(_setToken, component, targetUnit, _positionMultiplier);
        }

        rebalanceInfo[_setToken].rebalanceComponents = aggregateComponents;
        rebalanceInfo[_setToken].positionMultiplier = _positionMultiplier;
    }

    function trade(ISetToken _setToken, IERC20 _component) external nonReentrant onlyAllowedTrader(msg.sender, _setToken) onlyEOA() virtual {

        _validateTradeParameters(_setToken, _component);

        TradeInfo memory tradeInfo = _createTradeInfo(_setToken, _component);
        
        _executeTrade(tradeInfo);
        
        _updatePositionState(tradeInfo);

        executionInfo[_setToken][_component].lastTradeTimestamp = block.timestamp;
    }

    function tradeRemainingWETH(ISetToken _setToken, IERC20 _component) external nonReenterant onlyAllowedTrader(msg.sender, _setToken) onlyEOA() virtual {

        require(_noTokensToSell(), "Sell other set components first");
        require(executionInfo[_setToken][weth].targetUnit < _setToken.getDefaultPositionRealUnit(address(weth)), "WETH is below target unit and can not be traded");

        _validateTradeParameters(_setToken, _component);
        
        TradeInfo memory tradeInfo = _createTradeInfo(_setToken, _component);
        
        _executeTrade(tradeInfo);
        
        (, uint256 buyAmount) = _updatePositionState(tradeInfo);

        require(buyAmount < executionInfo[_setToken][_component.maxSize], "Trade amount exceeds max allowed trade size");   // can we revert earlier

        executionInfo[_setToken][_component].lastTradeTimestamp = block.timestamp;
    }

    function raiseAssetTargets(ISetToken _setToken) external onlyManagerAndValidSet(_setToken) virtual {
        require(
            _allTargetsMet() && index.getDefaultPositionRealUnit(address(weth)) > 0,
            "Targets must be met and ETH remaining in order to raise target"
        );

        rebalanceInfo[_setToken].positionMultiplier = rebalanceInfo[_setToken].positionMultiplier.preciseDiv(TARGET_RAISE_DIVISOR);
    }

    function setTradeMaximums(
        ISetToken _setToken,
        IERC20[] calldata _components,
        uint256[] calldata _tradeMaximums
    )
        external
        onlyManagerAndValidSet(index)
    {
        _validateArrays(_components, _tradeMaximums);

        for (uint256 i = 0; i < _components.length; i++) {
            executionInfo[_setToken][_components[i]].maxSize = _tradeMaximums[i];
            emit TradeMaximumUpdated(_setToken, _components[i], _tradeMaximums[i]);
        }
    }

    function setExchanges(
        ISetToken _setToken,
        IERC20[] calldata _components,
        string[] calldata _exchanges
    )
        external
        onlyManagerAndValidSet(index)
    {
        _validateArrays(_components, _exchanges);

        for (uint256 i = 0; i < _components.length; i++) {
            executionInfo[_setToken][_components[i]].exchange = _exchanges[i];
            emit AssetExchangeUpdated(_setToken, _components[i], _exchanges[i]);
        }
    }

    function setCoolOffPeriods(
        ISetToken _setToken,
        IERC20[] calldata _components,
        uint256[] calldata _coolOffPeriods
    )
        external
        onlyManagerAndValidSet(index)
    {
        _validateArrays(_components, _coolOffPeriods);

        for (uint256 i = 0; i < _components.length; i++) {
            executionInfo[_setToken][_components[i]].coolOffPeriod = _coolOffPeriods[i];
            emit CoolOffPeriodUpdated(_setToken, _components[i], _coolOffPeriods[i]);
        }
    }

    function updateRaiseTargetPercentage(ISetToken _setToken, uint256 _raiseTargetPercentage) external onlyManagerAndValidSet(_setToken) {
        require(_raiseTargetPercentage > 0, "raiseTargetPercentage > 0");
        rebalanceInfo[_setToken].raiseTargetPercentage = _raiseTargetPercentage;        
    }
    
    function updateTraderStatus(ISetToken _setToken, address[] calldata _traders, bool[] calldata _statuses) external onlyManagerAndValidSet(_setToken) {
        require(_traders.length == _statuses.length, "Array length mismatch");
        require(_traders.length > 0, "Array length must be > 0");
        require(!_traders.hasDuplicate(), "Cannot duplicate traders");

        for (uint256 i = 0; i < _traders.length; i++) {
            permissionInfo[_setToken].tradeAllowList[_traders[i]] = _statuses[i];
            emit TraderStatusUpdated(_setToken, _traders[i], _statuses[i]);
        }
    }

    function updateAnyoneTrade(ISetToken _setToken, bool _status) external onlyManagerAndValidSet(index) {
        permissionInfo[_setToken].anyoneTrade = _status;
        emit AnyoneTradeUpdated(_setToken, _status);
    }

    function initialize(ISetToken _setToken, IERC20 _components)
        external
        onlySetManager(_setToken, msg.sender)
        onlyValidAndPendingSet(_setToken)
    {
        require(address(_setToken) == address(0), "Module already in use");

        ISetToken.Position[] memory positions = _setToken.getPositions();

        for (uint256 i = 0; i < positions.length; i++) {
            ISetToken.Position memory position = positions[i];
            executionInfo[_setToken][position.component].targetUnit = position.unit.toUint256();
            executionInfo[_setToken][position.component].lastTradeTimestamp = 0;
        }

        // deviation
        _setToken.initializeModule();
    }

    function removeModule(ISetToken _setToken) external override {
        delete executionInfo[_setToken];    // deviation
        delete rebalanceInfo[_setToken];
        delete permissionInfo[_setToken];
    }


    /* ============ Internal Functions ============ */

    /**
     * Validate that enough time has elapsed since component's last trade.
     */
    function _validateTradeParameters(ISetToken _setToken, IERC20 _component) internal view virtual {
        require(rebalanceInfo[_setToken].rebalanceComponents.contains(_component), "Passed component not included in rebalance");

        TradeInfo memory componentInfo = executionInfo[_setToken][_component];
        require(
            componentInfo.lastTradeTimestamp.add(componentInfo.coolOffPeriod) <= block.timestamp,
            "Cool off period has not elapsed."
        );
    }

    function _createTradeInfo(ISetToken _setToken, IERC20 _component) internal view virtual returns (TradeInfo) {
        uint256 totalSupply = _setToken.totalSupply();

        uint256 componentMaxSize = executionInfo[_setToken][_component].maxSize;
        
        uint256 currentUnit = _setToken.getDefaultPositionRealUnit(address(_component)).toUint256();
        uint256 targetUnit = _normalizedTargetUnit(_setToken, _component);

        require(currentUnit != targetUnit, "Target already met");

        uint256 currentNotional = totalSupply.getDefaultTotalNotional(currentUnit);
        uint256 targetNotional = totalSupply.preciseMulCeil(targetUnit);

        TradeInfo memory tradeInfo;
        tradeInfo.setToken = _setToken;

        // _exchangeName?
        tradeInfo.exchangeAdapter = IExchangeAdapter(getAndValidateAdapter(_exchangeName));

        tradeInfo.isSendTokenFixed = targetNotional < currentNotional;
        
        (
            tradeInfo.fixedQuantityToken,
            tradeInfo.floatingQuantityToken,
            tradeInfo.totalFixedQuantity
        ) = tradeInfo.isSendTokenFixed
        ? (
            address(_component),
            address(weth),
            componentMaxSize.min(currentNotional.sub(targetNotional))
        ): (
            address(weth),
            address(component),
            componentMaxSize.min(targetNotional.sub(currentNotional))
        );
        
        tradeInfo.setTotalSupply = totalSupply;

        tradeInfo.preTradeFixedBalance = IERC20(tradeInfo.fixedQuantityToken).balanceOf(address(_setToken));
        tradeInfo.preTradeFloatingBalance = IERC20(tradeInfo.floatingQuantityToken).balanceOf(address(_setToken));
        return tradeInfo;
    }

    function _createTradeRemainingInfo(ISetToken _setToken, IERC20 _component) internal view returns (TradeInfo) {
        uint256 totalSupply = _setToken.totalSupply();

        uint256 componentMaxSize = executionInfo[_setToken][_component].maxSize;
        
        uint256 currentUnit = _setToken.getDefaultPositionRealUnit(address(_component)).toUint256();
        uint256 targetUnit = _normalizedTargetUnit(_setToken, _component);

        require(currentUnit != targetUnit, "Target already met");

        uint256 currentNotional = totalSupply.getDefaultTotalNotional(currentUnit);
        uint256 targetNotional = totalSupply.preciseMulCeil(targetUnit);

        TradeInfo memory tradeInfo;
        tradeInfo.setToken = _setToken;

        // _exchangeName?
        tradeInfo.exchangeAdapter = IExchangeAdapter(getAndValidateAdapter(_exchangeName));

        tradeInfo.isSendTokenFixed = true;
                
        tradeInfo.fixedQuantityToken = adddress(weth);
        tradeInfo.floatingQuantityToken = address(_component);

        tradeInfo.setTotalSupply = totalSupply;

        tradeInfo.totalFixedQuantity =  currentNotional.sub(targetNotional);
        
        tradeInfo.preTradeFixedBalance = weth.balanceOf(address(_setToken));
        tradeInfo.preTradeFloatingBalance = weth.balanceOf(address(_setToken));
        return tradeInfo;
    }
    
    function _executeTrade(TradeInfo memory _tradeInfo) internal virtual {
        
        (
            address sendToken,
            address reciveToken,
            uint256 totalSendQuantity,
            uint256 totalMinReceiveQuantity,
        ) = _tradeInfo.isSendTokenFixed
        ? (
            _tradeInfo.fixedQuantityToken,
            _tradeInfo.floatingQuantityToken,
            _tradeInfo.preTradeFixedBalance,    // deviation
            0
        ): (
            _tradeInfo.floatingQuantityToken,
            _tradeInfo.fixedQuantityToken,
            _tradeInfo.preTradeFloatingBalance,
            MAX_UINT_256
        );

        // Get spender address from exchange adapter and invoke approve for exact amount on SetToken
        _tradeInfo.setToken.invokeApprove(sendToken, _tradeInfo.exchangeAdapter.getSpender(), totalSendQuantity);

        bytes memory tradeData = _tradeInfo.exchangeAdapter.generateDataParam();    // TODO
        
        (
            address targetExchange,
            uint256 callValue,
            bytes memory methodData
        ) = _tradeInfo.exchangeAdapter.getTradeCalldata(
            sendToken,
            receiveToken,
            address(_tradeInfo.setToken),
            totalSendQuantity,
            totalMinReceiveQuantity,
            tradeData
        );

        _tradeInfo.setToken.invoke(targetExchange, callValue, methodData);
    }

    function _updatePositionState(TradeInfo memory _tradeInfo) internal returns (uint256 sellAmount, uint256 buyAmount) {
        ISetToken memory setToken = _tradeInfo.setToken;
        uint256 totalSupply = _tradeInfo.setToken.totalSupply();

        // naming deviation
        (uint256 postTradeFixedAmount,,) = setToken.calculateAndEditDefaultPosition(
            _tradeInfo.fixedQuantityToken,
            totalSupply,
            _tradeInfo.preTradeFixedBalance
        );
        (uint256 postTradeFloatingAmount,,) = setToken.calculateAndEditDefaultPosition(
            _tradeInfo.floatingQuantityToken,
            totalSupply,
            _tradeInfo.preTradeFloatingBalance
        );

        (
            address sellComponent,
            address buyComponent,
            uint256 sellAmount,
            uint256 buyAmount
        ) = _tradeInfo.isSendTokenFixed
        ? (
            _tradeInfo.fixedQuantityToken,
            _tradeInfo.floatingQuantityToken,
            _tradeInfo.preTradeFixedBalance.sub(postTradeFixedAmount),
            postTradeFloatingAmount.sub(_tradeInfo.preTradeFloatingBalance)
        ): (
            _tradeInfo.floatingQuantityToken,
            _tradeInfo.fixedQuantityToken,
            _tradeInfo.preTradeFloatingBalance.sub(postTradeFloatingAmount),
            postTradeFixedAmount.sub(_tradeInfo.preTradeFixedBalance)
        );
            
        emit TradeExecuted(
            setToken,
            sellComponent,
            buyComponent,
            _tradeInfo.exchangeAdapter,
            msg.sender,
            sellAmount,
            buyAmount
        );
    }

    // todo: modify _normalizedTargetUnit function
    /**
     * Check if there are any more tokens to sell.
     */
    function _noTokensToSell(_setToken) internal view returns (bool) {
        uint256 positionMultiplier = rebalanceInfo[_setToken].positionMultiplier;
        uint256 currentPositionMultiplier = _setToken.positionMultiplier().toUint256();
        address[] memory rebalanceComponents = rebalanceInfo[_setToken].rebalanceComponents;
        for (uint256 i = 0; i < rebalanceComponents.length; i++) {
            address component = rebalanceComponents[i];
            if (component != address(weth)) {
                uint256 normalizedTargetUnit = executionInfo[_setToken][component].targetUnit.mul(currentPositionMultiplier).div(positionMultiplier);
                bool canSell =  normalizedTargetUnit < _setToken.getDefaultPositionRealUnit(component).toUint256();
                if (canSell) { return false; }
            }
        }
        return true;
    }

    /**
     * Check if all targets are met
     */
    function _allTargetsMet(_setToken) internal view returns (bool) {
        uint256 positionMultiplier = rebalanceInfo[_setToken].positionMultiplier;
        uint256 currentPositionMultiplier = _setToken.positionMultiplier().toUint256();
        address[] memory rebalanceComponents = rebalanceInfo[_setToken].rebalanceComponents;
        for (uint256 i = 0; i < rebalanceComponents.length; i++) {
            address component = rebalanceComponents[i];
            if (component != address(weth)) {
                uint256 normalizedTargetUnit = executionInfo[_setToken][component].targetUnit.mul(currentPositionMultiplier).div(positionMultiplier);
                bool targetUnmet = normalizedTargetUnit != index.getDefaultPositionRealUnit(component).toUint256();
                if (targetUnmet) { return false; }
            }
        }
        return true;
    }


    /**
     * Normalize target unit to current position multiplier in case fees have been accrued.
     */
    function _normalizedTargetUnit(ISetToken _setToken, IERC20 _component) internal view returns(uint256) {
        uint256 currentPositionMultiplier = _setToken.positionMultiplier().toUint256();
        uint256 positionMultiplier = rebalanceInfo[_setToken].positionMultiplier; 
        return executionInfo[_setToken][_component].targetUnit.mul(currentPositionMultiplier).div(positionMultiplier);
    }

    /**
     * Determine if passed address is allowed to call trade for the SetToken. If anyoneTrade set to true anyone can call otherwise needs to be approved.
     */
    function _isAllowedTrader(address _caller, address _setToken) internal view virtual returns (bool) {
        TradePermissionInfo memory permissions = permissionInfo[_setToken];
        return permissions.anyoneTrade || permissions.tradeAllowList[_caller];
    }

    /**
     * Validate arrays are of equal length and not empty.
     */
    function _validateArrays(address[] calldata _components, uint256[] calldata _data) internal pure {
        require(_components.length == _data.length, "Array length mismatch");
        require(_components.length > 0, "Array length must be > 0");
        require(!_components.hasDuplicate(), "Cannot duplicate components");
    }
}