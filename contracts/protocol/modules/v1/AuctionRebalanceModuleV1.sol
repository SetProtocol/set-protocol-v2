/*
    Copyright 2023 Index Coop

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

import { AddressArrayUtils } from "../../../lib/AddressArrayUtils.sol";
import { IAuctionPriceAdapterV1 } from "../../../interfaces/IAuctionPriceAdapterV1.sol";
import { IController } from "../../../interfaces/IController.sol";
import { Invoke } from "../../lib/Invoke.sol";
import { ISetToken } from "../../../interfaces/ISetToken.sol";
import { ModuleBase } from "../../lib/ModuleBase.sol";
import { Position } from "../../lib/Position.sol";
import { PreciseUnitMath } from "../../../lib/PreciseUnitMath.sol";

/**
 * @title AuctionRebalanceModuleV1
 * @author Index Coop
 * @notice Facilitates rebalances for index sets via single-asset auctions. Managers initiate
 * rebalances specifying target allocations in precise units (scaled by 10^18), quote asset
 * (e.g., WETH, USDC), auction parameters per component, and rebalance duration through
 * startRebalance(). Bidders can participate via bid() for individual components. Excess
 * quote asset can be managed by proportionally increasing the targets using raiseAssetTargets().
 *
 * @dev Compatible with StreamingFeeModule and BasicIssuanceModule. Review compatibility if used
 * with additional modules.
 * @dev WARNING: If rebalances don't lock the SetToken, there's potential for bids to be front-run
 * by sizable issuance/redemption. This could lead to the SetToken not approaching its target allocation
 * proportionately to the bid size. To counteract this risk, a supply cap can be applied to the SetToken,
 * allowing regular issuance/redemption while preventing front-running with large issuance/redemption.
 * @dev WARNING: This contract does NOT support ERC-777 component tokens or quote assets.
 * @dev WARNING: Please note that the behavior of block.timestamp varies across different EVM chains. 
 * This contract does not incorporate additional checks for unique behavior or for elements like sequencer uptime. 
 * Ensure you understand these characteristics when interacting with the contract on different EVM chains.
 */
contract AuctionRebalanceModuleV1 is ModuleBase, ReentrancyGuard {
    using SafeCast for int256;
    using SafeCast for uint256;
    using SafeMath for uint256;
    using Position for uint256;
    using Math for uint256;
    using Position for ISetToken;
    using Invoke for ISetToken;
    using AddressArrayUtils for address[];
    using AddressArrayUtils for IERC20[];

    /* ============ Structs ============ */

    struct AuctionExecutionParams {
        uint256 targetUnit;                      // Target quantity of the component in Set, in precise units (10 ** 18).
        string priceAdapterName;                 // Identifier for the price adapter to be used.
        bytes priceAdapterConfigData;            // Encoded data for configuring the chosen price adapter.
    }

    struct BidPermissionInfo {
        bool isAnyoneAllowedToBid;               // Flag indicating if bids are open to anyone (true) or restricted (false).
        address[] biddersHistory;                // List of addresses that have been permissioned to bid.
        mapping(address => bool) bidAllowList;   // Mapping of addresses to a boolean indicating if they are allowed to bid.
    }

    struct RebalanceInfo {
        IERC20 quoteAsset;                       // Reference to the ERC20 token used to quote auctions.
        uint256 rebalanceStartTime;              // Unix timestamp marking the start of the rebalance.
        uint256 rebalanceDuration;               // Duration of the rebalance in seconds.
        uint256 positionMultiplier;              // Position multiplier when target units were calculated.
        uint256 raiseTargetPercentage;           // Optional percentage to increase all target units if allowed, in precise units.
        address[] rebalanceComponents;           // List of component tokens involved in the rebalance.
    }

    struct BidInfo {
        ISetToken setToken;                      // Instance of the SetToken contract that is being rebalanced.
        IERC20 sendToken;                        // The ERC20 token being sent in this bid.
        IERC20 receiveToken;                     // The ERC20 token being received in this bid.
        IAuctionPriceAdapterV1 priceAdapter;     // Instance of the price adapter contract used for this bid.
        bytes priceAdapterConfigData;            // Data for configuring the price adapter.
        bool isSellAuction;                      // Indicates if this is a sell auction (true) or a buy auction (false).
        uint256 auctionQuantity;                 // The quantity of the component being auctioned.
        uint256 componentPrice;                  // The price of the component as quoted by the price adapter.
        uint256 quantitySentBySet;               // Quantity of tokens sent by SetToken in this bid.
        uint256 quantityReceivedBySet;           // Quantity of tokens received by SetToken in this bid.
        uint256 preBidTokenSentBalance;          // Balance of tokens being sent by SetToken before the bid.
        uint256 preBidTokenReceivedBalance;      // Balance of tokens being received by SetToken before the bid.
        uint256 setTotalSupply;                  // Total supply of the SetToken at the time of the bid.
    }

    /* ============ Events ============ */

    /**
     * @dev Emitted when the target percentage increase is modified via setRaiseTargetPercentage()
     * @param setToken                   Reference to the SetToken undergoing rebalancing
     * @param newRaiseTargetPercentage   Updated percentage for potential target unit increases, in precise units (10 ** 18)
     */
    event RaiseTargetPercentageUpdated(
        ISetToken indexed setToken, 
        uint256 newRaiseTargetPercentage
    );

    /**
     * @dev Emitted upon calling raiseAssetTargets()
     * @param setToken                Reference to the SetToken undergoing rebalancing
     * @param newPositionMultiplier   Updated position multiplier for the SetToken rebalance
     */
    event AssetTargetsRaised(
        ISetToken indexed setToken, 
        uint256 newPositionMultiplier
    );

    /**
     * @dev Emitted upon toggling the bid permission setting via setAnyoneBid()
     * @param setToken               Reference to the SetToken undergoing rebalancing
     * @param isAnyoneAllowedToBid   Flag indicating if bids are open to all (true) or restricted (false)
     */
    event AnyoneBidUpdated(
        ISetToken indexed setToken, 
        bool isAnyoneAllowedToBid
    );

    /**
     * @dev Emitted when the bidding status of an address is changed via setBidderStatus()
     * @param setToken          Reference to the SetToken undergoing rebalancing
     * @param bidder            Address whose bidding permission status is toggled
     * @param isBidderAllowed   Flag indicating if the address is allowed (true) or not allowed (false) to bid
     */
    event BidderStatusUpdated(
        ISetToken indexed setToken, 
        address indexed bidder, 
        bool isBidderAllowed
    );

    /**
     * @dev Emitted when a rebalance is initiated using the startRebalance() function.
     * @param setToken                    Instance of the SetToken contract that is undergoing rebalancing.
     * @param quoteAsset                  The ERC20 token that is used as a quote currency for the auctions.
     * @param isSetTokenLocked            Indicates if the rebalance process locks the SetToken (true) or not (false).
     * @param rebalanceDuration           Duration of the rebalance process in seconds.
     * @param initialPositionMultiplier   Position multiplier when target units were calculated.
     * @param componentsInvolved          Array of addresses of the component tokens involved in the rebalance.
     * @param auctionParameters           Array of AuctionExecutionParams structs, containing auction parameters for each component token.
     */
    event RebalanceStarted(
        ISetToken indexed setToken,
        IERC20 indexed quoteAsset,
        bool isSetTokenLocked,
        uint256 rebalanceDuration,
        uint256 initialPositionMultiplier,
        address[] componentsInvolved,
        AuctionExecutionParams[] auctionParameters
    );

    /**
     * @dev Emitted upon execution of a bid via the bid() function.
     * @param setToken                   Instance of the SetToken contract that is being rebalanced.
     * @param sendToken                  The ERC20 token that is being sent by the bidder.
     * @param receiveToken               The ERC20 token that is being received by the bidder.
     * @param bidder                     The address of the bidder.
     * @param priceAdapter               Instance of the price adapter contract used for this bid.
     * @param isSellAuction              Indicates if this is a sell auction (true) or a buy auction (false).
     * @param price                      The price of the component in precise units (10 ** 18).
     * @param netQuantitySentBySet       The net amount of tokens sent by the SetToken in the bid.
     * @param netQuantityReceivedBySet   The net amount of tokens received by the SetToken in the bid.
     * @param protocolFee                The amount of the received token allocated as a protocol fee.
     * @param setTotalSupply             The total supply of the SetToken at the time of the bid.
     */
    event BidExecuted(
        ISetToken indexed setToken,
        address indexed sendToken,
        address indexed receiveToken,
        address bidder,
        IAuctionPriceAdapterV1 priceAdapter,
        bool isSellAuction,
        uint256 price,
        uint256 netQuantitySentBySet,
        uint256 netQuantityReceivedBySet,
        uint256 protocolFee,
        uint256 setTotalSupply
    );

    /**
     * @dev Emitted when a locked rebalance is concluded early via the unlock() function.
     * @param setToken            Instance of the SetToken contract that is being rebalanced.
     */
    event LockedRebalanceEndedEarly(
        ISetToken indexed setToken
    );


    /* ============ Constants ============ */

    uint256 private constant AUCTION_MODULE_V1_PROTOCOL_FEE_INDEX = 0;   // Index of the protocol fee percentage assigned to this module in the Controller.

    /* ============ State Variables ============ */

    mapping(ISetToken => mapping(IERC20 => AuctionExecutionParams)) public executionInfo;   // Maps SetToken to component tokens and their respective auction execution parameters.
    mapping(ISetToken => BidPermissionInfo) public permissionInfo;                          // Maps SetToken to information regarding bid permissions during a rebalance.
    mapping(ISetToken => RebalanceInfo) public rebalanceInfo;                               // Maps SetToken to data relevant to the most recent rebalance.

    /* ============ Modifiers ============ */

    modifier onlyAllowedBidder(ISetToken _setToken) {
        _validateOnlyAllowedBidder(_setToken);
        _;
    }

    /* ============ Constructor ============ */

    constructor(IController _controller) public ModuleBase(_controller) {}

    /* ============ External Functions ============ */

    /**
     * @dev MANAGER ONLY: Initiates the rebalance process by setting target allocations for the SetToken. Opens auctions
     * for filling by the Set's designated bidders. The function takes in new components to be added with their target units
     * and existing components with updated target units (set to 0 if removing). A positionMultiplier is supplied to adjust
     * target units, e.g., in cases where fee accrual affects the positionMultiplier of the SetToken, ensuring proportional
     * allocation among components. If target allocations are not met within the specified duration, the rebalance concludes
     * with the allocations achieved.
     * 
     * @dev WARNING: If rebalances don't lock the SetToken, enforce a supply cap on the SetToken to prevent front-running.
     *
     * @param _setToken                     The SetToken to be rebalanced.
     * @param _quoteAsset                   ERC20 token used as the quote asset in auctions.
     * @param _newComponents                Addresses of new components to be added.
     * @param _newComponentsAuctionParams   AuctionExecutionParams for new components, indexed corresponding to _newComponents.
     * @param _oldComponentsAuctionParams   AuctionExecutionParams for existing components, indexed corresponding to
     *                                      the current component positions. Set to 0 for components being removed.
     * @param _shouldLockSetToken           Indicates if the rebalance should lock the SetToken.
     * @param _rebalanceDuration            Duration of the rebalance in seconds.
     * @param _initialPositionMultiplier    Position multiplier at the start of the rebalance.
     */
    function startRebalance(
        ISetToken _setToken,
        IERC20 _quoteAsset,
        address[] calldata _newComponents,
        AuctionExecutionParams[] memory _newComponentsAuctionParams,
        AuctionExecutionParams[] memory _oldComponentsAuctionParams,
        bool _shouldLockSetToken,
        uint256 _rebalanceDuration,
        uint256 _initialPositionMultiplier
    )
        external
        onlyManagerAndValidSet(_setToken)
    {
        // Lock the SetToken if the _shouldLockSetToken flag is true and the SetToken is not already locked by this module
        if (_shouldLockSetToken && _setToken.locker() != address(this)) {
            _setToken.lock();
        }

        // Aggregate components and auction parameters
        (address[] memory allComponents, AuctionExecutionParams[] memory allAuctionParams) = _aggregateComponentsAndAuctionParams(
            _setToken.getComponents(),
            _newComponents,
            _newComponentsAuctionParams,
            _oldComponentsAuctionParams
        );

        // Set the execution information
        for (uint256 i = 0; i < allComponents.length; i++) {
            require(!_setToken.hasExternalPosition(allComponents[i]), "External positions not allowed");
            executionInfo[_setToken][IERC20(allComponents[i])] = allAuctionParams[i];
        }

        // Set the rebalance information
        rebalanceInfo[_setToken].quoteAsset = _quoteAsset;
        rebalanceInfo[_setToken].rebalanceStartTime = block.timestamp;
        rebalanceInfo[_setToken].rebalanceDuration = _rebalanceDuration;
        rebalanceInfo[_setToken].positionMultiplier = _initialPositionMultiplier;
        rebalanceInfo[_setToken].rebalanceComponents = allComponents;

        // Emit the RebalanceStarted event
        emit RebalanceStarted(_setToken, _quoteAsset, _shouldLockSetToken, _rebalanceDuration, _initialPositionMultiplier, allComponents, allAuctionParams);
    }

   /**
     * @dev ACCESS LIMITED: Only approved addresses can call this function unless isAnyoneAllowedToBid is enabled. This function
     * is used to push the current component units closer to the target units defined in startRebalance().
     *
     * Bidders specify the amount of the component they intend to buy or sell, and also specify the maximum/minimum amount 
     * of the quote asset they are willing to spend/receive. If the component amount is max uint256, the bid will fill
     * the remaining amount to reach the target.
     *
     * The auction parameters, which are set by the manager, are used to determine the price of the component. Any bids that 
     * either don't move the component units towards the target, or overshoot the target, will be reverted.
     *
     * If protocol fees are enabled, they are collected in the token received in a bid.
     * 
     * SELL AUCTIONS:
     * At the start of the rebalance, sell auctions are available to be filled in their full size.
     * 
     * BUY AUCTIONS:
     * Buy auctions can be filled up to the amount of quote asset available in the SetToken. This means that if the SetToken 
     * does not contain the quote asset as a component, buy auctions cannot be bid on until sell auctions have been executed 
     * and there is quote asset available in the SetToken.
     *
     * @param _setToken          The SetToken to be rebalanced.
     * @param _component         The component for which the auction is to be bid on.
     * @param _quoteAsset        The ERC20 token expected to be used as the quote asset by the bidder
     * @param _componentAmount   The amount of component in the bid.
     * @param _quoteAssetLimit   The maximum or minimum amount of quote asset that can be spent or received during the bid.
     * @param _isSellAuction     The direction of the auction expected by the bidder
     */
    function bid(
        ISetToken _setToken,
        IERC20 _component,
        IERC20 _quoteAsset,
        uint256 _componentAmount,
        uint256 _quoteAssetLimit,
        bool _isSellAuction
    )
        external
        nonReentrant
        onlyAllowedBidder(_setToken)
    {
        // Validate whether the bid targets are legitimate
        _validateBidTargets(_setToken, _component, _quoteAsset, _componentAmount);

        // Create the bid information structure
        BidInfo memory bidInfo = _createBidInfo(_setToken, _component, _componentAmount, _quoteAssetLimit, _isSellAuction);

        // Execute the token transfer specified in the bid information
        _executeBid(bidInfo);

        // Accrue protocol fee and store the amount
        uint256 protocolFeeAmount = _accrueProtocolFee(bidInfo);

        // Update the position state and store the net amounts
        (uint256 netAmountSent, uint256 netAmountReceived) = _updatePositionState(bidInfo);

        // Emit the BidExecuted event
        emit BidExecuted(
            bidInfo.setToken,
            address(bidInfo.sendToken),
            address(bidInfo.receiveToken),
            msg.sender,
            bidInfo.priceAdapter,
            bidInfo.isSellAuction,
            bidInfo.componentPrice,
            netAmountSent,
            netAmountReceived,
            protocolFeeAmount,
            bidInfo.setTotalSupply
        );
    }

    /**
     * @dev ACCESS LIMITED: Increases asset targets uniformly when all target units have been met but there is remaining quote asset.
     * Can be called multiple times if necessary. Targets are increased by the percentage specified by raiseAssetTargetsPercentage set by the manager.
     * This helps in reducing tracking error and providing greater granularity in reaching an equilibrium between the excess quote asset
     * and the components to be purchased. However, excessively raising targets may result in under-allocating to the quote asset as more of
     * it is spent buying components to meet the new targets.
     *
     * @param _setToken   The SetToken to be rebalanced.
     */
    function raiseAssetTargets(ISetToken _setToken)
        external
        onlyAllowedBidder(_setToken)
        virtual
    {
        // Ensure the rebalance is in progress
        require(!_isRebalanceDurationElapsed(_setToken), "Rebalance must be in progress");

        // Ensure that all targets are met and there is excess quote asset
        require(_canRaiseAssetTargets(_setToken), "Targets not met or quote asset =~ 0");

        // Calculate the new positionMultiplier
        uint256 newPositionMultiplier = rebalanceInfo[_setToken].positionMultiplier.preciseDiv(
            PreciseUnitMath.preciseUnit().add(rebalanceInfo[_setToken].raiseTargetPercentage)
        );

        // Update the positionMultiplier in the RebalanceInfo struct
        rebalanceInfo[_setToken].positionMultiplier = newPositionMultiplier;

        // Emit the AssetTargetsRaised event
        emit AssetTargetsRaised(_setToken, newPositionMultiplier);
    }

    /**
     * @dev Unlocks the SetToken after rebalancing. Can be called once the rebalance duration has elapsed.
     * Can only be called before the rebalance duration has elapsed if all targets are met, there is excess
     * or at-target quote asset, and raiseTargetPercentage is zero. Resets the raiseTargetPercentage to zero.
     *
     * @param _setToken The SetToken to be unlocked.
     */
    function unlock(ISetToken _setToken) external {
        bool isRebalanceDurationElapsed = _isRebalanceDurationElapsed(_setToken);
        bool canUnlockEarly = _canUnlockEarly(_setToken);

        // Ensure that either the rebalance duration has elapsed or the conditions for early unlock are met
        require(isRebalanceDurationElapsed || canUnlockEarly, "Cannot unlock early unless all targets are met and raiseTargetPercentage is zero");

        // If unlocking early, update the state
        if (canUnlockEarly) {
            delete rebalanceInfo[_setToken].rebalanceDuration;
            emit LockedRebalanceEndedEarly(_setToken);
        }

        // Reset the raiseTargetPercentage to zero
        rebalanceInfo[_setToken].raiseTargetPercentage = 0;

        // Unlock the SetToken
        _setToken.unlock();
    }

    /**
     * @dev MANAGER ONLY: Sets the percentage by which the target units for all components can be increased.
     * Can be called at any time by the manager.
     *
     * @param _setToken               The SetToken to be rebalanced.
     * @param _raiseTargetPercentage  The percentage (in precise units) by which the target units can be increased.
     */
    function setRaiseTargetPercentage(
        ISetToken _setToken,
        uint256 _raiseTargetPercentage
    )
        external
        onlyManagerAndValidSet(_setToken)
    {
        // Update the raise target percentage in the RebalanceInfo struct
        rebalanceInfo[_setToken].raiseTargetPercentage = _raiseTargetPercentage;

        // Emit an event to log the updated raise target percentage
        emit RaiseTargetPercentageUpdated(_setToken, _raiseTargetPercentage);
    }

    /**
     * @dev MANAGER ONLY: Toggles the permission status of specified addresses to call the `bid()` function.
     * The manager can call this function at any time.
     *
     * @param _setToken  The SetToken being rebalanced.
     * @param _bidders   An array of addresses whose bidding permission status is to be toggled.
     * @param _statuses  An array of booleans indicating the new bidding permission status for each corresponding address in `_bidders`.
     */
    function setBidderStatus(
        ISetToken _setToken,
        address[] memory _bidders,
        bool[] memory _statuses
    )
        external
        onlyManagerAndValidSet(_setToken)
    {
        // Validate that the input arrays have the same length
        _bidders.validatePairsWithArray(_statuses);

        // Iterate through the input arrays and update the permission status for each bidder
        for (uint256 i = 0; i < _bidders.length; i++) {
            _updateBiddersHistory(_setToken, _bidders[i], _statuses[i]);
            permissionInfo[_setToken].bidAllowList[_bidders[i]] = _statuses[i];

            // Emit an event to log the updated permission status
            emit BidderStatusUpdated(_setToken, _bidders[i], _statuses[i]);
        }
    }

    /**
     * @dev MANAGER ONLY: Toggles whether or not anyone is allowed to call the `bid()` function.
     * If set to true, it bypasses the bidAllowList, allowing any address to call the `bid()` function.
     * The manager can call this function at any time.
     *
     * @param _setToken  The SetToken instance.
     * @param _status    A boolean indicating if anyone can bid.
     */
    function setAnyoneBid(
        ISetToken _setToken,
        bool _status
    )
        external
        onlyManagerAndValidSet(_setToken)
    {
        // Update the anyoneBid status in the PermissionInfo struct
        permissionInfo[_setToken].isAnyoneAllowedToBid = _status;

        // Emit an event to log the updated anyoneBid status
        emit AnyoneBidUpdated(_setToken, _status);
    }


    /**
     * @dev MANAGER ONLY: Initializes the module for a SetToken, enabling access to AuctionModuleV1 for rebalances.
     * Retrieves the current units for each asset in the Set and sets the targetUnit to match the current unit, effectively
     * preventing any bidding until `startRebalance()` is explicitly called. The position multiplier is also logged to ensure that
     * any changes to the position multiplier do not unintentionally open the Set for rebalancing.
     *
     * @param _setToken   Address of the Set Token
     */
    function initialize(ISetToken _setToken)
        external
        onlySetManager(_setToken, msg.sender)
        onlyValidAndPendingSet(_setToken)
    {
        ISetToken.Position[] memory positions = _setToken.getPositions();

        for (uint256 i = 0; i < positions.length; i++) {
            ISetToken.Position memory position = positions[i];
            require(position.positionState == 0, "External positions not allowed");
            executionInfo[_setToken][IERC20(position.component)].targetUnit = position.unit.toUint256();
        }

        rebalanceInfo[_setToken].positionMultiplier = _setToken.positionMultiplier().toUint256();
        _setToken.initializeModule();
    }


    /**
     * @dev Called by a SetToken to notify that this module was removed from the SetToken.
     * Clears the `rebalanceInfo` and `permissionsInfo` of the calling SetToken.
     * IMPORTANT: The auction execution settings of the SetToken, including auction parameters,
     * are NOT DELETED. Restoring a previously removed module requires careful initialization of
     * the execution settings.
     */
    function removeModule() external override {
        BidPermissionInfo storage tokenPermissionInfo = permissionInfo[ISetToken(msg.sender)];

        for (uint256 i = 0; i < tokenPermissionInfo.biddersHistory.length; i++) {
            tokenPermissionInfo.bidAllowList[tokenPermissionInfo.biddersHistory[i]] = false;
        }

        delete rebalanceInfo[ISetToken(msg.sender)];
        delete permissionInfo[ISetToken(msg.sender)];
    }


    /* ============ External View Functions ============ */

    /**
     * @dev Checks externally if the rebalance duration has elapsed for the given SetToken.
     *
     * @param _setToken The SetToken whose rebalance duration is being checked.
     * @return bool True if the rebalance duration has elapsed; false otherwise.
     */
    function isRebalanceDurationElapsed(ISetToken _setToken) external view returns (bool) {
        return _isRebalanceDurationElapsed(_setToken);
    }

    /**
     * @dev Retrieves the array of components that are involved in the rebalancing of the given SetToken.
     *
     * @param _setToken    Instance of the SetToken.
     *
     * @return address[]   Array of component addresses involved in the rebalance.
     */
    function getRebalanceComponents(ISetToken _setToken)
        external
        view
        onlyValidAndInitializedSet(_setToken)
        returns (address[] memory)
    {
        return rebalanceInfo[_setToken].rebalanceComponents;
    }

    /**
     * @dev Calculates the quantity of a component involved in the rebalancing of the given SetToken,
     * and determines if the component is being bought or sold.
     *
     * @param _setToken    Instance of the SetToken being rebalanced.
     * @param _component   Instance of the IERC20 component to bid on.
     *
     * @return isSellAuction       Indicates if this is a sell auction (true) or a buy auction (false).
     * @return componentQuantity   Quantity of the component involved in the bid.
     */
    function getAuctionSizeAndDirection(
        ISetToken _setToken,
        IERC20 _component
    )
        external
        view
        onlyValidAndInitializedSet(_setToken)
        returns (bool isSellAuction, uint256 componentQuantity)
    {
        require(
            rebalanceInfo[_setToken].rebalanceComponents.contains(address(_component)),
            "Component not part of rebalance"
        );
        
        uint256 totalSupply = _setToken.totalSupply();
        return _calculateAuctionSizeAndDirection(_setToken, _component, totalSupply);
    }

    /**
     * @dev Retrieves the balance of the quote asset for a given SetToken.
     *
     * @param _setToken The SetToken whose quote asset balance is being retrieved.
     * @return uint256 The balance of the quote asset.
     */
    function getQuoteAssetBalance(ISetToken _setToken) external view returns (uint256) {
        RebalanceInfo storage rebalance = rebalanceInfo[_setToken];
        return IERC20(rebalance.quoteAsset).balanceOf(address(_setToken));
    }

    /**
     * @dev Generates a preview of the bid for a given component in the rebalancing of the SetToken.
     * It calculates the quantity of the component that will be exchanged and the direction of exchange.
     *
     * @param _setToken             Instance of the SetToken being rebalanced.
     * @param _component            Instance of the component auction to bid on.
     * @param _quoteAsset           The ERC20 token expected to be used as the quote asset by the bidder
     * @param _componentQuantity    Quantity of the component involved in the bid.
     * @param _quoteQuantityLimit   Maximum or minimum amount of quote asset spent or received during the bid.
     * @param _isSellAuction     The direction of the auction expected by the bidder
     *
     * @return BidInfo              Struct containing data for the bid.
     */
    function getBidPreview(
        ISetToken _setToken,
        IERC20 _component,
        IERC20 _quoteAsset,
        uint256 _componentQuantity,
        uint256 _quoteQuantityLimit,
        bool _isSellAuction
    )
        external
        view
        onlyValidAndInitializedSet(_setToken)
        returns (BidInfo memory)
    {
        _validateBidTargets(_setToken, _component, _quoteAsset, _componentQuantity);
        BidInfo memory bidInfo = _createBidInfo(_setToken, _component, _componentQuantity, _quoteQuantityLimit, _isSellAuction);
        
        return bidInfo;
    }

    /**
     * @dev Checks externally if the conditions for early unlock are met.
     *
     * @param _setToken The SetToken being checked.
     * @return bool True if early unlock conditions are met; false otherwise.
     */
    function canUnlockEarly(ISetToken _setToken) external view returns (bool) {
        return _canUnlockEarly(_setToken);
    }

    /**
     * @dev Checks externally if the conditions to raise asset targets are met.
     *
     * @param _setToken The SetToken being checked.
     * @return bool True if conditions to raise asset targets are met; false otherwise.
     */
    function canRaiseAssetTargets(ISetToken _setToken) external view returns (bool) {
        return _canRaiseAssetTargets(_setToken);
    }

    /**
     * @dev Checks externally if all target units for components have been met.
     *
     * @param _setToken Instance of the SetToken to be rebalanced.
     * @return bool True if all component's target units have been met; false otherwise.
     */
    function allTargetsMet(ISetToken _setToken) external view returns (bool) {
        return _allTargetsMet(_setToken);
    }

    /**
     * @dev Checks externally if the quote asset is in excess or at target.
     *
     * @param _setToken The SetToken being checked.
     * @return bool True if the quote asset is in excess or at target; false otherwise.
     */
    function isQuoteAssetExcessOrAtTarget(ISetToken _setToken) external view returns (bool) {
        return _isQuoteAssetExcessOrAtTarget(_setToken);
    }

    /**
     * @dev Determines whether the given bidder address is allowed to participate in the auction.
     *
     * @param _setToken   Instance of the SetToken for which the bid is being placed.
     * @param _bidder     Address of the bidder.
     *
     * @return bool       True if the given `_bidder` is permitted to bid, false otherwise.
     */
    function isAllowedBidder(ISetToken _setToken, address _bidder)
        external
        view
        onlyValidAndInitializedSet(_setToken)
        returns (bool)
    {
        return _isAllowedBidder(_setToken, _bidder);
    }

    /**
     * @dev Retrieves the list of addresses that are permitted to participate in the auction by calling `bid()`.
     *
     * @param _setToken           Instance of the SetToken for which to retrieve the list of allowed bidders.
     *
     * @return address[]          Array of addresses representing the allowed bidders.
     */
    function getAllowedBidders(ISetToken _setToken)
        external
        view
        onlyValidAndInitializedSet(_setToken)
        returns (address[] memory)
    {
        return permissionInfo[_setToken].biddersHistory;
    }

    /* ============ Internal Functions ============ */

    /**
     * @dev Aggregates the current SetToken components with the new components and validates their auction parameters.
     * Ensures that the sizes of the new components and new auction parameters arrays are the same, and that the number of current component auction parameters
     * matches the number of current components. Additionally, it validates that the price adapter exists, the price adapter configuration data is valid for the adapter,
     * and the target unit is greater than zero for new components. The function reverts if there is a duplicate component or if the array lengths are mismatched.
     *
     * @param _currentComponents          The current set of SetToken components.
     * @param _newComponents              The new components to add to the allocation.
     * @param _newComponentsAuctionParams The auction params for the new components, corresponding by index.
     * @param _oldComponentsAuctionParams The auction params for the old components, corresponding by index.
     * @return aggregateComponents        Combined array of current and new components, without duplicates.
     * @return aggregateAuctionParams     Combined array of old and new component auction params, without duplicates.
     */
    function _aggregateComponentsAndAuctionParams(
        address[] memory _currentComponents,
        address[] calldata _newComponents,
        AuctionExecutionParams[] memory _newComponentsAuctionParams,
        AuctionExecutionParams[] memory _oldComponentsAuctionParams
    )
        internal
        view
        returns (address[] memory aggregateComponents, AuctionExecutionParams[] memory aggregateAuctionParams)
    {
        // Validate input arrays: new components and new auction params must have the same length,
        // old components and old auction params must have the same length.
        require(_newComponents.length == _newComponentsAuctionParams.length, "New components and params length mismatch");
        require(_currentComponents.length == _oldComponentsAuctionParams.length, "Old components and params length mismatch");

        // Aggregate the current components and new components
        aggregateComponents = _currentComponents.extend(_newComponents);

        // Ensure there are no duplicates in the aggregated components
        require(!aggregateComponents.hasDuplicate(), "Cannot have duplicate components");

        // Aggregate and validate the old and new auction params
        aggregateAuctionParams = _concatAndValidateAuctionParams(_oldComponentsAuctionParams, _newComponentsAuctionParams);
    }

    /**
     * @dev Validates that the component is an eligible target for bids during the rebalance. Bids cannot be placed explicitly
     * on the rebalance quote asset, it may only be implicitly bid by being the quote asset for other component bids.
     * 
     * @param _setToken          The SetToken instance involved in the rebalance.
     * @param _component         The component to be validated.
     * @param _quoteAsset        The ERC20 token expected to be used as the quote asset by the bidder
     * @param _componentAmount   The amount of component in the bid.
     */
    function _validateBidTargets(
        ISetToken _setToken,
        IERC20 _component,
        IERC20 _quoteAsset,
        uint256 _componentAmount
    )
        internal
        view
    {
        IERC20 quoteAsset = rebalanceInfo[_setToken].quoteAsset;
        // Ensure that the component is not the quote asset, as it cannot be explicitly bid on.
        require(_component != quoteAsset, "Cannot bid explicitly on Quote Asset");

        // Ensure that the auction quote asset matches the quote asset expected by the bidder.
        require(_quoteAsset == quoteAsset, "Quote asset mismatch");

        // Ensure that the component is part of the rebalance.
        require(rebalanceInfo[_setToken].rebalanceComponents.contains(address(_component)), "Component not part of rebalance");

        // Ensure that the SetToken doesn't have an external position for the component.
        require(!_setToken.hasExternalPosition(address(_component)), "External positions not allowed");

        // Ensure that the rebalance is in progress.
        require(!_isRebalanceDurationElapsed(_setToken), "Rebalance must be in progress");

        // Ensure that the component amount is greater than zero.
        require(_componentAmount > 0, "Component amount must be > 0");
    }

    /**
     * @dev Creates and returns a BidInfo struct. The function reverts if the auction target has already been met.
     *
     * @param _setToken             The SetToken instance involved in the rebalance.
     * @param _component            The component to bid on.
     * @param _componentQuantity    The amount of component in the bid.
     * @param _quoteQuantityLimit   The max/min amount of quote asset to be spent/received during the bid.
     * @param _isSellAuction     The direction of the auction expected by the bidder
     *
     * @return bidInfo              Struct containing data for the bid.
     */
    function _createBidInfo(
        ISetToken _setToken,
        IERC20 _component,
        uint256 _componentQuantity,
        uint256 _quoteQuantityLimit,
        bool _isSellAuction
    )
        internal
        view
        returns (BidInfo memory bidInfo)
    {
        // Populate the bid info structure with basic information.
        bidInfo.setToken = _setToken;
        bidInfo.setTotalSupply = _setToken.totalSupply();
        bidInfo.priceAdapter = _getAuctionPriceAdapter(_setToken, _component);
        bidInfo.priceAdapterConfigData = executionInfo[_setToken][_component].priceAdapterConfigData;

        // Calculate the auction size and direction.
        (bidInfo.isSellAuction, bidInfo.auctionQuantity) = _calculateAuctionSizeAndDirection(
            _setToken,
            _component,
            bidInfo.setTotalSupply
        );

        // Ensure that the auction direction matches the direction expected by the bidder.
        require(bidInfo.isSellAuction == _isSellAuction, "Auction direction mismatch");

        // Settle the auction if the component quantity is max uint256.
        // Ensure that the component quantity in the bid does not exceed the available auction quantity.
        if (_componentQuantity == type(uint256).max) {
            _componentQuantity = bidInfo.auctionQuantity;
        } else {
            require(_componentQuantity <= bidInfo.auctionQuantity, "Bid size exceeds auction quantity");
        }

        // Set the sendToken and receiveToken based on the auction type (sell or buy).
        (bidInfo.sendToken, bidInfo.receiveToken) = _getSendAndReceiveTokens(bidInfo.isSellAuction, _setToken, _component);

        // Retrieve the current price for the component.
        bidInfo.componentPrice = bidInfo.priceAdapter.getPrice(
            address(_setToken),
            address(_component),
            _componentQuantity,
            block.timestamp.sub(rebalanceInfo[_setToken].rebalanceStartTime),
            rebalanceInfo[_setToken].rebalanceDuration,
            bidInfo.priceAdapterConfigData
        );
        
        // Calculate the quantity of quote asset involved in the bid.
        uint256 quoteAssetQuantity = _calculateQuoteAssetQuantity(
            bidInfo.isSellAuction,
            _componentQuantity,
            bidInfo.componentPrice
        );

        // Store pre-bid token balances for later use.
        bidInfo.preBidTokenSentBalance = bidInfo.sendToken.balanceOf(address(_setToken));
        bidInfo.preBidTokenReceivedBalance = bidInfo.receiveToken.balanceOf(address(_setToken));

        // Validate quote asset quantity against bidder's limit.
        _validateQuoteAssetQuantity(
            bidInfo.isSellAuction,
            quoteAssetQuantity,
            _quoteQuantityLimit,
            bidInfo.preBidTokenSentBalance
        );

        // Calculate quantities sent and received by the Set during the bid.
        (bidInfo.quantitySentBySet, bidInfo.quantityReceivedBySet) = _calculateQuantitiesForBid(
            bidInfo.isSellAuction,
            _componentQuantity,
            quoteAssetQuantity
        );
    }

    /**
     * @notice Determines tokens involved in the bid based on auction type.
     * @param isSellAuction       Is the auction a sell type.
     * @param _setToken           The SetToken involved in the rebalance.
     * @param _component          The component involved in the auction.
     * @return                    The tokens to send and receive in the bid.
     */
    function _getSendAndReceiveTokens(bool isSellAuction, ISetToken _setToken, IERC20 _component) private view returns (IERC20, IERC20) {
        return isSellAuction ? (_component, IERC20(rebalanceInfo[_setToken].quoteAsset)) : (IERC20(rebalanceInfo[_setToken].quoteAsset), _component);
    }

    /**
     * @notice Calculates the quantity of quote asset involved in the bid.
     * @param isSellAuction        Is the auction a sell type.
     * @param _componentQuantity   The amount of component in the bid.
     * @param _componentPrice      The price of the component.
     * @return                     The quantity of quote asset in the bid.
     */
    function _calculateQuoteAssetQuantity(bool isSellAuction, uint256 _componentQuantity, uint256 _componentPrice) private pure returns (uint256) {
        return isSellAuction ? _componentQuantity.preciseMulCeil(_componentPrice) : _componentQuantity.preciseMul(_componentPrice);
    }

    /**
     * @notice Validates the quote asset quantity against bidder's limit.
     * @param isSellAuction            Is the auction a sell type.
     * @param quoteAssetQuantity       The quantity of quote asset in the bid.
     * @param _quoteQuantityLimit      The max/min amount of quote asset to be spent/received.
     * @param preBidTokenSentBalance   The balance of tokens sent before the bid.
     */
    function _validateQuoteAssetQuantity(bool isSellAuction, uint256 quoteAssetQuantity, uint256 _quoteQuantityLimit, uint256 preBidTokenSentBalance) private pure {
        if (isSellAuction) {
            require(quoteAssetQuantity <= _quoteQuantityLimit, "Quote asset quantity exceeds limit");
        } else {
            require(quoteAssetQuantity >= _quoteQuantityLimit, "Quote asset quantity below limit");
            require(quoteAssetQuantity <= preBidTokenSentBalance, "Insufficient quote asset balance");
        }
    }

    /**
     * @notice Calculates the quantities sent and received by the Set during the bid.
     * @param isSellAuction        Is the auction a sell type.
     * @param _componentQuantity   The amount of component in the bid.
     * @param quoteAssetQuantity   The quantity of quote asset in the bid.
     * @return                     The quantities of tokens sent and received by the Set.
     */
    function _calculateQuantitiesForBid(bool isSellAuction, uint256 _componentQuantity, uint256 quoteAssetQuantity) private pure returns (uint256, uint256) {
        return isSellAuction ? (_componentQuantity, quoteAssetQuantity) : (quoteAssetQuantity, _componentQuantity);
    }

    /**
     * @dev Calculates the size and direction of the auction for a given component. Determines whether the component
     * is being bought or sold and the quantity required to settle the auction.
     *
     * @param _setToken            The SetToken instance to be rebalanced.
     * @param _component           The component whose auction size and direction need to be calculated.
     * @param _totalSupply         The total supply of the SetToken.
     *
     * @return isSellAuction       Indicates if this is a sell auction (true) or a buy auction (false).
     * @return maxComponentQty     The maximum quantity of the component to be exchanged to settle the auction.
     */
    function _calculateAuctionSizeAndDirection(
        ISetToken _setToken,
        IERC20 _component,
        uint256 _totalSupply
    )
        internal
        view
        returns (bool isSellAuction, uint256 maxComponentQty)
    {
        uint256 protocolFee = controller.getModuleFee(address(this), AUCTION_MODULE_V1_PROTOCOL_FEE_INDEX);

        // Retrieve the current and target units, and notional amounts of the component
        (
            uint256 currentUnit,
            uint256 targetUnit,
            uint256 currentNotional,
            uint256 targetNotional
        ) = _getUnitsAndNotionalAmounts(_setToken, _component, _totalSupply);

        // Ensure that the current unit and target unit are not the same
        require(currentUnit != targetUnit, "Target already met");

        // Determine whether the component is being sold (sendToken) or bought
        isSellAuction = targetNotional < currentNotional;

        // Calculate the max quantity of the component to be exchanged. If buying, account for the protocol fees.
        maxComponentQty = isSellAuction
            ? currentNotional.sub(targetNotional)
            : targetNotional.sub(currentNotional).preciseDiv(PreciseUnitMath.preciseUnit().sub(protocolFee));
    }

      /**
     * @dev Executes the bid by performing token transfers.
     *
     * @param _bidInfo      Struct containing the bid information.
     */
    function _executeBid(
        BidInfo memory _bidInfo
    )
        internal
    {
        // Transfer the received tokens from the sender to the SetToken.
        transferFrom(
            _bidInfo.receiveToken,
            msg.sender,
            address(_bidInfo.setToken),
            _bidInfo.quantityReceivedBySet
        );

        // Invoke the transfer of the sent tokens from the SetToken to the sender.
        _bidInfo.setToken.strictInvokeTransfer(
            address(_bidInfo.sendToken),
            msg.sender,
            _bidInfo.quantitySentBySet
        );
    }

    /**
     * @dev Calculates the protocol fee based on the tokens received during the bid and transfers it
     * from the SetToken to the protocol recipient.
     *
     * @param _bidInfo  Struct containing information related to the bid.
     *
     * @return uint256  The amount of the received tokens taken as a protocol fee.
     */
    function _accrueProtocolFee(BidInfo memory _bidInfo) internal returns (uint256) {
        IERC20 receiveToken = IERC20(_bidInfo.receiveToken);
        ISetToken setToken = _bidInfo.setToken;

        // Calculate the amount of tokens exchanged during the bid.
        uint256 exchangedQuantity = receiveToken.balanceOf(address(setToken))
            .sub(_bidInfo.preBidTokenReceivedBalance);
        
        // Calculate the protocol fee.
        uint256 protocolFee = getModuleFee(AUCTION_MODULE_V1_PROTOCOL_FEE_INDEX, exchangedQuantity);
        
        // Transfer the protocol fee from the SetToken to the protocol recipient.
        payProtocolFeeFromSetToken(setToken, address(_bidInfo.receiveToken), protocolFee);
        
        return protocolFee;
    }

    /**
     * @dev Updates the positions of the SetToken after the bid. This function should be called
     * after the protocol fees have been accrued. It calculates and returns the net amount of tokens
     * used and received during the bid.
     *
     * @param _bidInfo  Struct containing information related to the bid.
     *
     * @return uint256  The net amount of send tokens used in the bid.
     * @return uint256  The net amount of receive tokens after accounting for protocol fees.
     */
    function _updatePositionState(BidInfo memory _bidInfo)
        internal
        returns (uint256, uint256)
    {
        ISetToken setToken = _bidInfo.setToken;
        
        // Calculate and update positions for send tokens.
        (uint256 postBidSendTokenBalance,,) = setToken.calculateAndEditDefaultPosition(
            address(_bidInfo.sendToken),
            _bidInfo.setTotalSupply,
            _bidInfo.preBidTokenSentBalance
        );
        
        // Calculate and update positions for receive tokens.
        (uint256 postBidReceiveTokenBalance,,) = setToken.calculateAndEditDefaultPosition(
            address(_bidInfo.receiveToken),
            _bidInfo.setTotalSupply,
            _bidInfo.preBidTokenReceivedBalance
        );

        // Calculate the net amount of tokens used and received.
        uint256 netSendAmount = _bidInfo.preBidTokenSentBalance.sub(postBidSendTokenBalance);
        uint256 netReceiveAmount = postBidReceiveTokenBalance.sub(_bidInfo.preBidTokenReceivedBalance);

        return (netSendAmount, netReceiveAmount);
    }

    /**
     * @dev Retrieves the unit and notional amount values for the current position and target.
     * These are necessary to calculate the bid size and direction.
     *
     * @param _setToken             Instance of the SetToken to be rebalanced.
     * @param _component            The component to calculate notional amounts for.
     * @param _totalSupply          SetToken total supply.
     *
     * @return uint256              Current default position real unit of the component.
     * @return uint256              Normalized unit of the bid target.
     * @return uint256              Current notional amount, based on total notional amount of SetToken default position.
     * @return uint256              Target notional amount, based on total SetToken supply multiplied by targetUnit.
     */
    function _getUnitsAndNotionalAmounts(
        ISetToken _setToken,
        IERC20 _component,
        uint256 _totalSupply
    )
        internal
        view
        returns (uint256, uint256, uint256, uint256)
    {
        uint256 currentUnit = _getDefaultPositionRealUnit(_setToken, _component);
        uint256 targetUnit = _getNormalizedTargetUnit(_setToken, _component);

        uint256 currentNotionalAmount = _totalSupply.getDefaultTotalNotional(currentUnit);
        uint256 targetNotionalAmount = _totalSupply.preciseMulCeil(targetUnit);

        return (currentUnit, targetUnit, currentNotionalAmount, targetNotionalAmount);
    }

    /**
     * @dev Checks if all target units for components have been met.
     *
     * @param _setToken        Instance of the SetToken to be rebalanced.
     *
     * @return bool            True if all component's target units have been met; false otherwise.
     */
    function _allTargetsMet(ISetToken _setToken) internal view returns (bool) {
        address[] memory rebalanceComponents = rebalanceInfo[_setToken].rebalanceComponents;

        for (uint256 i = 0; i < rebalanceComponents.length; i++) {
            if (_targetUnmet(_setToken, rebalanceComponents[i])) {
                return false;
            }
        }

        return true;
    }

    /**
     * @dev Determines if the target units for a given component are met. Takes into account minor rounding errors.
     * WETH is not checked as it is allowed to float around its target.
     *
     * @param _setToken        Instance of the SetToken to be rebalanced.
     * @param _component       Component whose target is evaluated.
     *
     * @return bool            True if component's target units are met; false otherwise.
     */
    function _targetUnmet(
        ISetToken _setToken,
        address _component
    )
        internal
        view
        returns(bool)
    {
        if (_component == address(rebalanceInfo[_setToken].quoteAsset)) return false;

        uint256 normalizedTargetUnit = _getNormalizedTargetUnit(_setToken, IERC20(_component));
        uint256 currentUnit = _getDefaultPositionRealUnit(_setToken, IERC20(_component));

        return (normalizedTargetUnit > 0)
            ? !normalizedTargetUnit.approximatelyEquals(currentUnit, 1)
            : normalizedTargetUnit != currentUnit;
    }

    /**
     * @dev Retrieves the SetToken's default position real unit.
     *
     * @param _setToken        Instance of the SetToken.
     * @param _component       Component to fetch the default position for.
     *
     * @return uint256         Real unit position.
     */
    function _getDefaultPositionRealUnit(
        ISetToken _setToken,
        IERC20 _component
    )
        internal
        view
        returns (uint256)
    {
        return _setToken.getDefaultPositionRealUnit(address(_component)).toUint256();
    }

    /**
     * @dev Calculates and retrieves the normalized target unit value for a given component.
     *
     * @param _setToken        Instance of the SetToken.
     * @param _component       Component whose normalized target unit is required.
     *
     * @return uint256         Normalized target unit of the component.
     */
    function _getNormalizedTargetUnit(
        ISetToken _setToken,
        IERC20 _component
    )
        internal
        view
        returns(uint256)
    {
        // (targetUnit * current position multiplier) / position multiplier at the start of rebalance
        return executionInfo[_setToken][_component]
            .targetUnit
            .mul(_setToken.positionMultiplier().toUint256())
            .div(rebalanceInfo[_setToken].positionMultiplier);
    }

    /**
     * @dev Checks if the specified address is allowed to call the bid for the SetToken.
     * If `anyoneBid` is set to true, any address is allowed, otherwise the address
     * must be explicitly approved.
     *
     * @param _setToken         Instance of the SetToken to be rebalanced.
     * @param _bidder           Address of the bidder.
     *
     * @return bool             True if the address is allowed to bid, false otherwise.
     */
    function _isAllowedBidder(
        ISetToken _setToken, 
        address _bidder
    ) 
        internal 
        view 
        returns (bool) 
    {
        BidPermissionInfo storage permissions = permissionInfo[_setToken];
        return permissions.isAnyoneAllowedToBid || permissions.bidAllowList[_bidder];
    }

    /**
     * @dev Updates the permission status of a bidder and maintains a history. This function adds
     * the bidder to the history if being permissioned, and removes it if being unpermissioned.
     * Ensures that AddressArrayUtils does not throw by verifying the presence of the address
     * before removal.
     *
     * @param _setToken         Instance of the SetToken.
     * @param _bidder           Address of the bidder whose permission is being updated.
     * @param _status           The permission status being set (true for permissioned, false for unpermissioned).
     */
    function _updateBiddersHistory(
        ISetToken _setToken, 
        address _bidder, 
        bool _status
    ) 
        internal 
    {
        if (_status && !permissionInfo[_setToken].biddersHistory.contains(_bidder)) {
            permissionInfo[_setToken].biddersHistory.push(_bidder);
        } else if(!_status && permissionInfo[_setToken].biddersHistory.contains(_bidder)) {
            permissionInfo[_setToken].biddersHistory.removeStorage(_bidder);
        }
    }

    /**
     * @dev Checks if the rebalance duration has elapsed for the given SetToken.
     *
     * @param _setToken The SetToken whose rebalance duration is being checked.
     * @return bool True if the rebalance duration has elapsed; false otherwise.
     */
    function _isRebalanceDurationElapsed(ISetToken _setToken) internal view returns (bool) {
        RebalanceInfo storage rebalance = rebalanceInfo[_setToken];
        return (rebalance.rebalanceStartTime.add(rebalance.rebalanceDuration)) <= block.timestamp;
    }

    /**
     * @dev Checks if the conditions for early unlock are met.
     *
     * @param _setToken The SetToken being checked.
     * @return bool True if early unlock conditions are met; false otherwise.
     */
    function _canUnlockEarly(ISetToken _setToken) internal view returns (bool) {
        RebalanceInfo storage rebalance = rebalanceInfo[_setToken];
        return _allTargetsMet(_setToken) && _isQuoteAssetExcessOrAtTarget(_setToken) && rebalance.raiseTargetPercentage == 0;
    }

    /**
     * @dev Checks if the quote asset is in excess or at target.
     *
     * @param _setToken The SetToken being checked.
     * @return bool True if the quote asset is in excess or at target; false otherwise.
     */
    function _isQuoteAssetExcessOrAtTarget(ISetToken _setToken) internal view returns (bool) {
        RebalanceInfo storage rebalance = rebalanceInfo[_setToken];
        bool isExcess = _getDefaultPositionRealUnit(_setToken, rebalance.quoteAsset) > _getNormalizedTargetUnit(_setToken, rebalance.quoteAsset);
        bool isAtTarget = _getDefaultPositionRealUnit(_setToken, rebalance.quoteAsset).approximatelyEquals(_getNormalizedTargetUnit(_setToken, rebalance.quoteAsset), 1);
        return isExcess || isAtTarget;
    }

    /**
     * @dev Checks if the conditions to raise asset targets are met.
     *
     * @param _setToken The SetToken being checked.
     * @return bool True if conditions to raise asset targets are met; false otherwise.
     */
    function _canRaiseAssetTargets(ISetToken _setToken) internal view returns (bool) {
        RebalanceInfo storage rebalance = rebalanceInfo[_setToken];
        bool isQuoteAssetExcess = _getDefaultPositionRealUnit(_setToken, rebalance.quoteAsset) > _getNormalizedTargetUnit(_setToken, rebalance.quoteAsset);
        return _allTargetsMet(_setToken) && isQuoteAssetExcess;
    }

    /**
     * @dev Retrieves the price adapter address for a component after verifying its existence
     * in the IntegrationRegistry. This function ensures the validity of the adapter during a bid.
     *
     * @param _setToken        Instance of the SetToken to be rebalanced.
     * @param _component       Component whose price adapter is to be fetched.
     *
     * @return IAuctionPriceAdapter    The price adapter's address.
     */
    function _getAuctionPriceAdapter(
        ISetToken _setToken,
        IERC20 _component
    )
        internal
        view
        returns(IAuctionPriceAdapterV1)
    {
        return IAuctionPriceAdapterV1(getAndValidateAdapter(executionInfo[_setToken][_component].priceAdapterName));
    }

    /**
     * @dev Concatenates two arrays of AuctionExecutionParams after validating them.
     *
     * @param _oldAuctionParams     The first array of AuctionExecutionParams.
     * @param _newAuctionParams     The second array of AuctionExecutionParams.
     * @return concatenatedParams   The concatenated array of AuctionExecutionParams.
     */
    function _concatAndValidateAuctionParams(
        AuctionExecutionParams[] memory _oldAuctionParams,
        AuctionExecutionParams[] memory _newAuctionParams
    )
        internal
        view
        returns (AuctionExecutionParams[] memory concatenatedParams)
    {
        uint256 oldLength = _oldAuctionParams.length;
        uint256 newLength = _newAuctionParams.length;

        // Initialize the concatenated array with the combined size of the input arrays
        concatenatedParams = new AuctionExecutionParams[](oldLength + newLength);

        // Copy and validate the old auction params
        for (uint256 i = 0; i < oldLength; i++) {
            _validateAuctionExecutionPriceParams(_oldAuctionParams[i]);
            concatenatedParams[i] = _oldAuctionParams[i];
        }

        // Append and validate the new auction params
        for (uint256 j = 0; j < newLength; j++) {
            require(_newAuctionParams[j].targetUnit > 0, "New component target unit must be greater than 0");
            _validateAuctionExecutionPriceParams(_newAuctionParams[j]);
            concatenatedParams[oldLength + j] = _newAuctionParams[j];
        }

        return concatenatedParams;
    }

    /**
     * @dev Validates the given auction execution price adapter params.
     *
     * @param auctionParams The auction parameters to validate.
     */
    function _validateAuctionExecutionPriceParams(AuctionExecutionParams memory auctionParams) internal view {
        IAuctionPriceAdapterV1 adapter = IAuctionPriceAdapterV1(getAndValidateAdapter(auctionParams.priceAdapterName));
        require(adapter.isPriceAdapterConfigDataValid(auctionParams.priceAdapterConfigData), "Price adapter config data invalid");
    }

    /* ============== Modifier Helpers ===============
     * Internal functions used to reduce bytecode size
     */

    /*
     * Bidder must be permissioned for SetToken
     */
    function _validateOnlyAllowedBidder(ISetToken _setToken) internal view {
        require(_isAllowedBidder(_setToken, msg.sender), "Address not permitted to bid");
    }
}
