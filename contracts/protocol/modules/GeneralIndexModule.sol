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
    using AddressArrayUtils for IERC20[];
    using Uint256ArrayUtils for uint256[];

    /* ============ Struct ============ */

    struct TradeExecutionParams {
        uint256 targetUnit;              // Target unit of component for Set
        uint256 maxSize;                 // Max trade size in precise units
        uint256 coolOffPeriod;           // Required time between trades for the asset
        uint256 lastTradeTimestamp;      // Timestamp of last trade
        string exchangeName;             // Name of exchange adapter
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

    struct TradeInfo {
        ISetToken setToken;                     // Instance of SetToken
        IExchangeAdapter exchangeAdapter;       // Instance of Exchange Adapter
        address sendToken;                      // Address of token being sold
        address receiveToken;                   // Address of token being bought
        bool isSendTokenFixed;                  // Boolean indicating fixed asset is send token
        uint256 setTotalSupply;                 // Total supply of Set (in precise units)
        uint256 totalFixedQuantity;             // Total quanity of fixed asset being traded
        uint256 floatingQuantityLimit;          // Max/min amount of floating token spent/received during trade
        uint256 preTradeSendTokenBalance;       // Total initial balance of token being sold
        uint256 preTradeReceiveTokenBalance;    // Total initial balance of token being bought
    }

    /* ============ Events ============ */

    event TargetUnitsUpdated(ISetToken indexed _setToken, address indexed _component, uint256 _newUnit, uint256 _positionMultiplier);
    event TradeMaximumUpdated(ISetToken indexed _setToken, address indexed _component, uint256 _newMaximum);
    event AssetExchangeUpdated(ISetToken indexed _setToken, address indexed _component, string _newExchangeName);
    event CoolOffPeriodUpdated(ISetToken indexed _setToken, address indexed _component, uint256 _newCoolOffPeriod);
    event RaiseTargetPercentageUpdated(ISetToken indexed _setToken, uint256 indexed _raiseTargetPercentage);

    event AnyoneTradeUpdated(ISetToken indexed _setToken, bool indexed _status);
    event TraderStatusUpdated(ISetToken indexed _setToken, address indexed _trader, bool _status);
    
    event TradeExecuted(
        ISetToken indexed _setToken,
        address indexed _sellComponent,
        address indexed _buyComponent,
        IExchangeAdapter _exchangeAdapter,
        address _executor,
        uint256 _amountSold,
        uint256 _netAmountBought,
        uint256 _protocolFee
    );
    
    /* ============ Constants ============ */
    
    uint256 private constant GENERAL_INDEX_MODULE_PROTOCOL_FEE_INDEX = 0;
    
    /* ============ State Variables ============ */

    mapping(ISetToken => mapping(IERC20 => TradeExecutionParams)) public executionInfo;     // Mapping of SetToken to execution parameters of each asset on SetToken
    mapping(ISetToken => TradePermissionInfo) public permissionInfo;                        // Mapping of SetToken to trading permissions
    mapping(ISetToken => RebalanceInfo) public rebalanceInfo;                               // Mapping of SetToken to relevant data for current rebalance
    IWETH public weth;                                                                      // Weth contract address
    
    /* ============ Modifiers ============ */

    modifier onlyAllowedTrader(ISetToken _setToken, address _caller) {
        require(_isAllowedTrader(_setToken, _caller), "Address not permitted to trade");
        _;
    }

    modifier onlyEOAIfUnrestricted(ISetToken _setToken) {
        if(permissionInfo[_setToken].anyoneTrade) {
            require(msg.sender == tx.origin, "Caller must be EOA Address");
        }
        _;
    }

    /* ============ Constructor ============ */

    constructor(IController _controller, IWETH _weth) public ModuleBase(_controller) {
        weth = _weth;
    }

    /* ============ External Functions ============ */

    /**
     * MANAGER ONLY: Set new target units, zeroing out any units for components being removed from index. Log position multiplier to
     * adjust target units in case fees are accrued. Validate that every oldComponent has a targetUnit and that no components have been duplicated.
     *
     * @param _setToken                         Address of the SetToken to be rebalanced
     * @param _newComponents                    Array of new components to add to allocation
     * @param _newComponentsTargetUnits         Array of target units at end of rebalance for new components, maps to same index of _newComponents array
     * @param _oldComponentsTargetUnits         Array of target units at end of rebalance for old component, maps to same index of
     *                                               _setToken.getComponents() array, if component being removed set to 0.
     * @param _positionMultiplier               Position multiplier when target units were calculated, needed in order to adjust target units
     *                                               if fees accrued
     */
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
        require(
            currentComponents.length == _oldComponentsTargetUnits.length, 
            "New allocation must have target for all old components"
        );

        address[] memory aggregateComponents = currentComponents.extend(_newComponents);
        uint256[] memory aggregateTargetUnits = _oldComponentsTargetUnits.extend(_newComponentsTargetUnits);

        require(!aggregateComponents.hasDuplicate(), "Cannot duplicate components");

        for (uint256 i = 0; i < aggregateComponents.length; i++) {
            
            executionInfo[_setToken][IERC20(aggregateComponents[i])].targetUnit = aggregateTargetUnits[i];

            emit TargetUnitsUpdated(_setToken, aggregateComponents[i], aggregateTargetUnits[i], _positionMultiplier);
        }

        rebalanceInfo[_setToken].rebalanceComponents = aggregateComponents;
        rebalanceInfo[_setToken].positionMultiplier = _positionMultiplier;
    }

    /**
     * ACCESS LIMITED: Only approved addresses can call if anyoneTrade is false. Determines trade size
     * and direction and swaps into or out of WETH on exchange specified by manager.
     *
     * @param _setToken             Address of the SetToken
     * @param _component            Address of SetToken component to trade
     * @param _ethQuantityLimit     Max/min amount of ETH spent/received during trade
     */
    function trade(
        ISetToken _setToken, 
        IERC20 _component, 
        uint256 _ethQuantityLimit
    ) 
        external 
        nonReentrant 
        onlyAllowedTrader(_setToken, msg.sender) 
        onlyEOAIfUnrestricted(_setToken) 
        virtual 
    {

        _validateTradeParameters(_setToken, _component);

        TradeInfo memory tradeInfo = _createTradeInfo(_setToken, _component, _ethQuantityLimit);
        
        _executeTrade(tradeInfo);
        
        uint256 protocolFee = _accrueProtocolFee(tradeInfo);
        
        (uint256 sellAmount, uint256 netBuyAmount) = _updatePositionState(tradeInfo);

        executionInfo[_setToken][_component].lastTradeTimestamp = block.timestamp;

        emit TradeExecuted(
            tradeInfo.setToken,
            tradeInfo.sendToken,
            tradeInfo.receiveToken,
            tradeInfo.exchangeAdapter,
            msg.sender,
            sellAmount,
            netBuyAmount,
            protocolFee
        );
    }

    /**
     * ACCESS LIMITED: Only approved addresses can call if anyoneTrade is false. Only callable when 1) there are no
     * more components to be sold and, 2) entire remaining WETH amount can be traded such that resulting inflows won't
     * exceed components maxTradeSize nor overshoot the target unit. To be used near the end of rebalances when a
     * component's calculated trade size is greater in value than remaining WETH.
     *
     * @param _setToken                     Address of the SetToken
     * @param _component                    Address of the SetToken component to trade
     * @param _componentQuantityLimit       Min amount of component received during trade
     */
    function tradeRemainingWETH(
        ISetToken _setToken, 
        IERC20 _component, 
        uint256 _componentQuantityLimit
    ) 
        external 
        nonReentrant 
        onlyAllowedTrader(_setToken, msg.sender) 
        onlyEOAIfUnrestricted(_setToken) 
        virtual 
    {

        require(_noTokensToSell(_setToken), "Sell other set components first");
        require(
            executionInfo[_setToken][weth].targetUnit < _setToken.getDefaultPositionRealUnit(address(weth)).toUint256(), 
            "WETH is below target unit and can not be traded"
        );

        _validateTradeParameters(_setToken, _component);
        
        TradeInfo memory tradeInfo = _createTradeRemainingInfo(_setToken, _component, _componentQuantityLimit);
        
        _executeTrade(tradeInfo);
        
        uint256 protocolFee = _accrueProtocolFee(tradeInfo);
        
        (uint256 sellAmount, uint256 netBuyAmount) = _updatePositionState(tradeInfo);
        
        require(
            netBuyAmount.add(protocolFee) < executionInfo[_setToken][_component].maxSize, 
            "Trade amount exceeds max allowed trade size"
        );
        
        _validateComponentPositionUnit(_setToken, _component);
        
        executionInfo[_setToken][_component].lastTradeTimestamp = block.timestamp;
        
        emit TradeExecuted(
            tradeInfo.setToken,
            tradeInfo.sendToken,
            tradeInfo.receiveToken,
            tradeInfo.exchangeAdapter,
            msg.sender,
            sellAmount,
            netBuyAmount,
            protocolFee
        );
    }

    /**
     * ACCESS LIMITED: For situation where all target units met and remaining WETH, uniformly raise targets by same
     * percentage in order to allow further trading. Can be called multiple times if necessary, increase should be
     * small in order to reduce tracking error.
     *
     * @param _setToken             Address of the SetToken
     */
    function raiseAssetTargets(ISetToken _setToken) external onlyAllowedTrader(_setToken, msg.sender) virtual {
        require(
            _allTargetsMet(_setToken)  
            && _setToken.getDefaultPositionRealUnit(address(weth)).toUint256() > executionInfo[_setToken][weth].targetUnit,
            "Targets must be met and ETH remaining in order to raise target"
        );

        rebalanceInfo[_setToken].positionMultiplier = rebalanceInfo[_setToken].positionMultiplier.preciseDiv(
            PreciseUnitMath.preciseUnit().add(rebalanceInfo[_setToken].raiseTargetPercentage)
        );
    }
    
    /**
     * MANAGER ONLY: Set trade maximums for passed components of the SetToken
     *
     * @param _setToken             Address of the SetToken
     * @param _components           Array of components
     * @param _tradeMaximums        Array of trade maximums mapping to correct component
     */
    function setTradeMaximums(
        ISetToken _setToken,
        address[] calldata _components,
        uint256[] calldata _tradeMaximums
    )
        external
        onlyManagerAndValidSet(_setToken)
    {
        _validateUintArrays(_components, _tradeMaximums);

        for (uint256 i = 0; i < _components.length; i++) {
            executionInfo[_setToken][IERC20(_components[i])].maxSize = _tradeMaximums[i];
            emit TradeMaximumUpdated(_setToken, _components[i], _tradeMaximums[i]);
        }
    }

    /**
     * MANAGER ONLY: Set exchange for passed components of the SetToken
     *
     * @param _setToken             Address of the SetToken
     * @param _components           Array of components
     * @param _exchangeNames        Array of exchange names mapping to correct component
     */
    function setExchanges(
        ISetToken _setToken,
        address[] calldata _components,
        string[] calldata _exchangeNames
    )
        external
        onlyManagerAndValidSet(_setToken)
    {
        require(_components.length == _exchangeNames.length, "Array length mismatch");
        require(_components.length > 0, "Array length must be > 0");
        require(!_components.hasDuplicate(), "Cannot duplicate components");

        for (uint256 i = 0; i < _components.length; i++) {
            executionInfo[_setToken][IERC20(_components[i])].exchangeName = _exchangeNames[i];
            emit AssetExchangeUpdated(_setToken, _components[i], _exchangeNames[i]);
        }
    }

    /**
     * MANAGER ONLY: Set cool off periods for passed components of the SetToken
     *
     * @param _setToken             Address of the SetToken
     * @param _components           Array of components
     * @param _coolOffPeriods       Array of cool off periods to correct component
     */
    function setCoolOffPeriods(
        ISetToken _setToken,
        address[] calldata _components,
        uint256[] calldata _coolOffPeriods
    )
        external
        onlyManagerAndValidSet(_setToken)
    {
        _validateUintArrays(_components, _coolOffPeriods);

        for (uint256 i = 0; i < _components.length; i++) {
            executionInfo[_setToken][IERC20(_components[i])].coolOffPeriod = _coolOffPeriods[i];
            emit CoolOffPeriodUpdated(_setToken, _components[i], _coolOffPeriods[i]);
        }
    }

    /**
     * MANAGER ONLY: Set amount by which all component's targets units would be raised
     *
     * @param _setToken                     Address of the SetToken
     * @param _raiseTargetPercentage        Amount to raise all component's unit targets by (in precise units)     
     */
    function updateRaiseTargetPercentage(
        ISetToken _setToken, 
        uint256 _raiseTargetPercentage
    ) 
        external 
        onlyManagerAndValidSet(_setToken) 
    {
        require(_raiseTargetPercentage > 0, "Target percentage must be > 0");
        rebalanceInfo[_setToken].raiseTargetPercentage = _raiseTargetPercentage;
        emit RaiseTargetPercentageUpdated(_setToken, _raiseTargetPercentage);       
    }
    
    /**
     * MANAGER ONLY: Toggle ability for passed addresses to trade.
     *
     * @param _setToken          Address of the SetToken
     * @param _traders           Array trader addresses to toggle status
     * @param _statuses          Booleans indicating if matching trader can trade
     */
    function updateTraderStatus(
        ISetToken _setToken, 
        address[] calldata _traders, 
        bool[] calldata _statuses
    ) 
        external 
        onlyManagerAndValidSet(_setToken) 
    {
        require(_traders.length == _statuses.length, "Array length mismatch");
        require(_traders.length > 0, "Array length must be > 0");
        require(!_traders.hasDuplicate(), "Cannot duplicate traders");

        for (uint256 i = 0; i < _traders.length; i++) {
            permissionInfo[_setToken].tradeAllowList[_traders[i]] = _statuses[i];
            emit TraderStatusUpdated(_setToken, _traders[i], _statuses[i]);
        }
    }

    /**
     * MANAGER ONLY: Toggle whether anyone can trade, bypassing the traderAllowList
     *
     * @param _setToken         Address of the SetToken
     * @param _status           Boolean indicating if anyone can trade
     */
    function updateAnyoneTrade(ISetToken _setToken, bool _status) external onlyManagerAndValidSet(_setToken) {
        permissionInfo[_setToken].anyoneTrade = _status;
        emit AnyoneTradeUpdated(_setToken, _status);
    }

    /**
     * MANAGER ONLY: Set target units to current units and last trade to zero. Initialize module.
     *
     * @param _setToken         Address of the Set Token
     */
    function initialize(ISetToken _setToken)
        external
        onlySetManager(_setToken, msg.sender)
        onlyValidAndPendingSet(_setToken)
    {
        ISetToken.Position[] memory positions = _setToken.getPositions();

        for (uint256 i = 0; i < positions.length; i++) {
            ISetToken.Position memory position = positions[i];
            executionInfo[_setToken][IERC20(position.component)].targetUnit = position.unit.toUint256();
            executionInfo[_setToken][IERC20(position.component)].lastTradeTimestamp = 0;
        }

        _setToken.initializeModule();
    }
    
    /**
     * Called by a SetToken to notify that this module was removed from the SetToken. 
     * Clears the state of the calling SetToken.
     */
    function removeModule() external override {
        // delete executionInfo[ISetToken(msg.sender)];    // todo: figure out how to delete efficiently
        delete rebalanceInfo[ISetToken(msg.sender)];
        delete permissionInfo[ISetToken(msg.sender)];
    }
    
    /**
     * Returns the array of SetToken components involved in rebalance.
     * 
     * @param _setToken         Address of the SetToken
     * 
     * @return                  Array of _setToken components involved in rebalance
     */
    function getRebalanceComponents(ISetToken _setToken) external view returns(address[] memory) {
        return rebalanceInfo[_setToken].rebalanceComponents;
    }

    /* ============ Internal Functions ============ */

    /**
     * Validate that component is a valid component and enough time has elapsed since component's last trade.
     *
     * @param _setToken         Instance of the SetToken
     * @param _component        IERC20 component to be validated
     */
    function _validateTradeParameters(ISetToken _setToken, IERC20 _component) internal view virtual {
        require(address(_component) != address(weth), "Can not explicitly trade WETH");
        require(
            rebalanceInfo[_setToken].rebalanceComponents.contains(address(_component)), 
            "Passed component not included in rebalance"
        );

        TradeExecutionParams memory componentInfo = executionInfo[_setToken][_component];
        require(
            componentInfo.lastTradeTimestamp.add(componentInfo.coolOffPeriod) <= block.timestamp,
            "Cool off period has not elapsed."
        );
    }

    /**
     * Create and return TradeInfo struct. This function reverts if the target has already been met.
     *
     * @param _setToken             Instance of the SetToken to rebalance
     * @param _component            IERC20 component to trade
     * @param _ethQuantityLimit     Max/min amount of weth spent/received during trade
     *
     * @return TradeInfo            Struct containing data for trade
     */
    function _createTradeInfo(
        ISetToken _setToken, 
        IERC20 _component, 
        uint256 _ethQuantityLimit
    ) 
        internal 
        view 
        virtual 
        returns (TradeInfo memory) 
    {
        
        uint256 totalSupply = _setToken.totalSupply();

        uint256 componentMaxSize = executionInfo[_setToken][_component].maxSize;
        
        uint256 currentUnit = _setToken.getDefaultPositionRealUnit(address(_component)).toUint256();
        uint256 targetUnit = _getNormalizedTargetUnit(_setToken, _component);

        require(currentUnit != targetUnit, "Target already met");

        uint256 currentNotional = totalSupply.getDefaultTotalNotional(currentUnit);
        uint256 targetNotional = totalSupply.preciseMulCeil(targetUnit);        

        TradeInfo memory tradeInfo;
        tradeInfo.setToken = _setToken;

        tradeInfo.exchangeAdapter = IExchangeAdapter(getAndValidateAdapter(executionInfo[_setToken][_component].exchangeName));

        tradeInfo.isSendTokenFixed = targetNotional < currentNotional;
        
        tradeInfo.sendToken = tradeInfo.isSendTokenFixed ? address(_component) : address(weth);
        
        tradeInfo.receiveToken = tradeInfo.isSendTokenFixed ? address(weth): address(_component);
        
        tradeInfo.preTradeSendTokenBalance = IERC20(tradeInfo.sendToken).balanceOf(address(_setToken));
        tradeInfo.preTradeReceiveTokenBalance = IERC20(tradeInfo.receiveToken).balanceOf(address(_setToken));
        
        tradeInfo.setTotalSupply = totalSupply;

        tradeInfo.totalFixedQuantity = tradeInfo.isSendTokenFixed 
            ? componentMaxSize.min(currentNotional.sub(targetNotional))
            : componentMaxSize.min(targetNotional.sub(currentNotional));

        tradeInfo.floatingQuantityLimit = tradeInfo.isSendTokenFixed 
            ? _ethQuantityLimit 
            : _ethQuantityLimit.min(tradeInfo.preTradeSendTokenBalance);

        return tradeInfo;
    }

    /**
     * Create and return TradeInfo struct. This function does NOT check if the WETH target has been met.
     *
     * @param _setToken                     Instance of the SetToken to rebalance
     * @param _component                    IERC20 component to trade
     * @param _componentQuantityLimit       Min amount of component received during trade
     *
     * @return TradeInfo                    Struct containing data for trade
     */
    function _createTradeRemainingInfo(
        ISetToken _setToken, 
        IERC20 _component, 
        uint256 _componentQuantityLimit
    ) 
        internal 
        view 
        returns (TradeInfo memory) 
    {
        
        uint256 totalSupply = _setToken.totalSupply();

        uint256 currentUnit = _setToken.getDefaultPositionRealUnit(address(weth)).toUint256();
        uint256 targetUnit = _getNormalizedTargetUnit(_setToken, weth);

        uint256 currentNotional = totalSupply.getDefaultTotalNotional(currentUnit);
        uint256 targetNotional = totalSupply.preciseMulCeil(targetUnit);

        TradeInfo memory tradeInfo;
        tradeInfo.setToken = _setToken;

        tradeInfo.exchangeAdapter = IExchangeAdapter(getAndValidateAdapter(executionInfo[_setToken][_component].exchangeName));

        tradeInfo.isSendTokenFixed = true;
                
        tradeInfo.sendToken = address(weth);
        tradeInfo.receiveToken = address(_component);

        tradeInfo.setTotalSupply = totalSupply;

        tradeInfo.totalFixedQuantity =  currentNotional.sub(targetNotional);
        tradeInfo.floatingQuantityLimit = _componentQuantityLimit;
        
        tradeInfo.preTradeSendTokenBalance = weth.balanceOf(address(_setToken));
        tradeInfo.preTradeReceiveTokenBalance = _component.balanceOf(address(_setToken));
        return tradeInfo;
    }
    
    /**
     * Invoke approve for send token, get method data and invoke trade in the context of the SetToken.
     *
     * @param _tradeInfo            Struct containing trade information used in internal functions
     */
    function _executeTrade(TradeInfo memory _tradeInfo) internal virtual {
        
        _tradeInfo.setToken.invokeApprove(
            _tradeInfo.sendToken, 
            _tradeInfo.exchangeAdapter.getSpender(), 
            _tradeInfo.isSendTokenFixed ? _tradeInfo.totalFixedQuantity : _tradeInfo.floatingQuantityLimit
        );

        bytes memory tradeData = _tradeInfo.exchangeAdapter.generateDataParam(
            _tradeInfo.sendToken, 
            _tradeInfo.receiveToken, 
            _tradeInfo.isSendTokenFixed
        );
        
        (
            address targetExchange,
            uint256 callValue,
            bytes memory methodData
        ) = _tradeInfo.exchangeAdapter.getTradeCalldata(
            _tradeInfo.sendToken,
            _tradeInfo.receiveToken,
            address(_tradeInfo.setToken),
            _tradeInfo.isSendTokenFixed ? _tradeInfo.totalFixedQuantity : _tradeInfo.floatingQuantityLimit,
            _tradeInfo.isSendTokenFixed ? _tradeInfo.floatingQuantityLimit : _tradeInfo.totalFixedQuantity,
            tradeData
        );

        _tradeInfo.setToken.invoke(targetExchange, callValue, methodData);
    }

    /**
     * Retrieve fee from controller and calculate total protocol fee and send from SetToken to protocol recipient.
     * The protocol fee is collected from the receiving token in the trade.
     *
     * @param _tradeInfo                Struct containing trade information used in internal functions
     * 
     * @return uint256                  Amount of receive token taken as protocol fee
     */    
    function _accrueProtocolFee(TradeInfo memory _tradeInfo) internal returns (uint256) {
        
        uint256 exchangedQuantity =  IERC20(_tradeInfo.receiveToken).balanceOf(address(_tradeInfo.setToken)).sub(_tradeInfo.preTradeReceiveTokenBalance);
        
        uint256 protocolFeeTotal = getModuleFee(GENERAL_INDEX_MODULE_PROTOCOL_FEE_INDEX, exchangedQuantity);
        
        payProtocolFeeFromSetToken(_tradeInfo.setToken, _tradeInfo.receiveToken, protocolFeeTotal);
        
        return protocolFeeTotal;
    }

    /**
     * Update SetToken positions. If this function is called after the fees have been accrued, 
     * it returns net amount of bought tokens.
     *
     * @param _tradeInfo                Struct containing trade information used in internal functions
     *
     * @return sellAmount               Amount of sendTokens used in the trade
     * @return netBuyAmount             Amount of receiveTokens received in the trade (net of fees)
     */
    function _updatePositionState(TradeInfo memory _tradeInfo) internal returns (uint256 sellAmount, uint256 netBuyAmount) {
        uint256 totalSupply = _tradeInfo.setToken.totalSupply();

        (uint256 postTradeSendTokenBalance,,) = _tradeInfo.setToken.calculateAndEditDefaultPosition(
            _tradeInfo.sendToken,
            totalSupply,
            _tradeInfo.preTradeSendTokenBalance
        );
        (uint256 postTradeReceiveTokenBalance,,) = _tradeInfo.setToken.calculateAndEditDefaultPosition(
            _tradeInfo.receiveToken,
            totalSupply,
            _tradeInfo.preTradeReceiveTokenBalance
        );

        sellAmount = _tradeInfo.preTradeSendTokenBalance.sub(postTradeSendTokenBalance);
        netBuyAmount = postTradeReceiveTokenBalance.sub(_tradeInfo.preTradeReceiveTokenBalance);
    }

    /**
     * Check if there are any more tokens to sell.
     *
     * @param _setToken             Instance of the SetToken to be rebalanced
     *
     * @return bool                 True if there is not any component that can be sold, otherwise false
     */
    function _noTokensToSell(ISetToken _setToken) internal view returns (bool) {
        uint256 positionMultiplier = rebalanceInfo[_setToken].positionMultiplier;
        uint256 currentPositionMultiplier = _setToken.positionMultiplier().toUint256();
        address[] memory rebalanceComponents = rebalanceInfo[_setToken].rebalanceComponents;
        for (uint256 i = 0; i < rebalanceComponents.length; i++) {
            address component = rebalanceComponents[i];
            if (component != address(weth)) {
                uint256 normalizedTargetUnit = _normalizeTargetUnit(_setToken, IERC20(component), currentPositionMultiplier, positionMultiplier);
                bool canSell =  normalizedTargetUnit < _setToken.getDefaultPositionRealUnit(component).toUint256();
                if (canSell) { return false; }
            }
        }
        return true;
    }

    /**
     * Check if all targets are met
     *
     * @param _setToken             Instance of the SetToken to be rebalanced
     *
     * @return bool                 True if all component's target units have been met, otherwise false
     */
    function _allTargetsMet(ISetToken _setToken) internal view returns (bool) {
        uint256 positionMultiplier = rebalanceInfo[_setToken].positionMultiplier;
        uint256 currentPositionMultiplier = _setToken.positionMultiplier().toUint256();
        address[] memory rebalanceComponents = rebalanceInfo[_setToken].rebalanceComponents;
        for (uint256 i = 0; i < rebalanceComponents.length; i++) {
            address component = rebalanceComponents[i];
            if (component != address(weth)) {
                uint256 normalizedTargetUnit = _normalizeTargetUnit(_setToken, IERC20(component), currentPositionMultiplier, positionMultiplier);
                bool targetUnmet = normalizedTargetUnit != _setToken.getDefaultPositionRealUnit(component).toUint256();
                if (targetUnmet) { return false; }
            }
        }
        return true;
    }

    /**
     * Normalize target unit to current position multiplier in case fees have been accrued.
     *
     * @param _setToken             Instance of the SettToken to be rebalanced
     * @param _component            IERC20 component whose normalized target unit is required
     *
     * @return uint256              Normalized target unit of the component
     */
    function _getNormalizedTargetUnit(ISetToken _setToken, IERC20 _component) internal view returns(uint256) {
        uint256 currentPositionMultiplier = _setToken.positionMultiplier().toUint256();
        uint256 positionMultiplier = rebalanceInfo[_setToken].positionMultiplier;
        return _normalizeTargetUnit(_setToken, _component, currentPositionMultiplier, positionMultiplier);
    }

    /**
     * Calculates the normalized target unit value.
     *
     * @param _setToken                         Instance of the SettToken to be rebalanced
     * @param _component                        IERC20 component whose normalized target unit is required
     * @param _currentPositionMultiplier        Current position multiplier value
     * @param _positionMultiplier               Position multiplier value when rebalance started
     *
     * @return uint256                          Normalized target unit of the component
     */
    function _normalizeTargetUnit(
        ISetToken _setToken, 
        IERC20 _component, 
        uint256 _currentPositionMultiplier, 
        uint256 _positionMultiplier
    ) 
        internal 
        view 
        returns (uint256) 
    {
        return executionInfo[_setToken][_component].targetUnit.mul(_currentPositionMultiplier).div(_positionMultiplier);
    }
    
    /**
     * Validate component position unit has not exceeded it's target unit.
     * 
     * @param _setToken         Instance of the SetToken
     * @param _component        IERC20 component whose position units are to be validated
     */
    function _validateComponentPositionUnit(ISetToken _setToken, IERC20 _component) internal view {
        uint256 currentUnit = _setToken.getDefaultPositionRealUnit(address(_component)).toUint256();
        uint256 targetUnit = _getNormalizedTargetUnit(_setToken, _component);
        require(currentUnit <= targetUnit, "Can not exceed target unit");
    }
    
    /**
     * Determine if passed address is allowed to call trade for the SetToken. 
     * If anyoneTrade set to true anyone can call otherwise needs to be approved.
     * 
     * @param _setToken             Instance of SetToken to be rebalanced
     * @param  _caller              Address of the trader who called contract function
     *
     * @return bool                 True if caller is an approved trader for the SetToken
     */
    function _isAllowedTrader(ISetToken _setToken, address _caller) internal view returns (bool) {
        TradePermissionInfo storage permissions = permissionInfo[_setToken];
        return permissions.anyoneTrade || permissions.tradeAllowList[_caller];
    }

    /**
     * Validate arrays are of equal length and not empty.
     *
     * @param _components           Array of components
     * @param _data                 Array of uint256 values
     */
    function _validateUintArrays(address[] calldata _components, uint256[] calldata _data) internal pure {
        require(_components.length == _data.length, "Array length mismatch");
        require(_components.length > 0, "Array length must be > 0");
        require(!_components.hasDuplicate(), "Cannot duplicate components");
    }
}