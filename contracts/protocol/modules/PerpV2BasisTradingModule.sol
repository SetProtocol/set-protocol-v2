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

pragma solidity 0.6.10;
pragma experimental "ABIEncoderV2";

import { IController } from "../../interfaces/IController.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IMarketRegistry } from "../../interfaces/external/perp-v2/IMarketRegistry.sol";
import { Invoke } from "../lib/Invoke.sol";
import { IQuoter } from "../../interfaces/external/perp-v2/IQuoter.sol";
import { ISetToken } from "../../interfaces/ISetToken.sol";
import { IVault } from "../../interfaces/external/perp-v2/IVault.sol";
import { ModuleBase } from "../lib/ModuleBase.sol";
import { PerpV2 } from "../integration/lib/PerpV2.sol";
import { PerpV2LeverageModule } from "./PerpV2LeverageModule.sol";
import { Position } from "../lib/Position.sol";
import { PreciseUnitMath } from "../../lib/PreciseUnitMath.sol";

import "hardhat/console.sol";

// TODO
// 1. Add a settle funding helper function, that updates tracked settled funding can calls ClearingHouse.settleAllFunding()?

/**
 * @title PerpV2BasisTradingModule
 * @author Set Protocol
 *
 * @notice Smart contract that extends functionality offered by PerpV2LeverageModule. It tracks funding that is settled due to actions 
 * on Perpetual protocol and allows tracked funding to be withdrawn by the manager. The manager can also collect performance fees on 
 * the withdrawn funding. 
 *
 * NOTE: The external position unit is only updated on an as-needed basis during issuance/redemption. It does not reflect the current
 * value of the Set's perpetual position. The current value can be calculated from getPositionNotionalInfo.
 */
contract PerpV2BasisTradingModule is PerpV2LeverageModule {


    /* ============ Structs ============ */

    struct FeeState {
        address feeRecipient;                     // Address to accrue fees to
        uint256 maxPerformanceFeePercentage;      // Max performance fee manager commits to using (1% = 1e16, 100% = 1e18)
        uint256 performanceFeePercentage;         // Percent of funding yield to manager (1% = 1e16, 100% = 1e18)
    }


    /* ============ Events ============ */

    /**
     * @dev Emitted on performance fee update
     * @param _setToken             Instance of SetToken
     * @param _newPerformanceFee    New performance fee percentage (1% = 1e16)
     */
    event PerformanceFeeUpdated(ISetToken indexed _setToken, uint256 _newPerformanceFee);

    /**
     * @dev Emitted on fee recipient update
     * @param _setToken             Instance of SetToken
     * @param _newFeeRecipient      New performance fee recipient
     */
    event FeeRecipientUpdated(ISetToken indexed _setToken, address _newFeeRecipient);

    /**
     * @dev Emitted on funding withdraw
     * @param _setToken             Instance of SetToken
     * @param _collateralToken      Token being withdrawn as funding (USDC)
     * @param _amountWithdrawn      Amount of funding being withdrawn from Perp (USDC)
     * @param _managerFee           Amount of performance fee accrued to manager (USDC)
     * @param _protocolFee          Amount of performance fee accrued to protocol (USDC)
     */
    event FundingWithdrawn(
        ISetToken indexed  _setToken, 
        IERC20 _collateralToken, 
        uint256 _amountWithdrawn, 
        uint256 _managerFee, 
        uint256 _protocolFee
    );

    /* ============ Constants ============ */

    // 1 index stores protocol performance fee % on the controller, charged in the _handleFees function
    uint256 private constant PROTOCOL_PERFORMANCE_FEE_INDEX = 1;

    /* ============ State Variables ============ */

    // Mapping to store fee settings for each SetToken
    mapping(ISetToken => FeeState) public feeStates;

    // Mapping to store funding that has been settled on Perpetual Protocol due to actions via this module for 
    // given SetToken
    mapping(ISetToken => uint256) public settledFunding;

    /* ============ Constructor ============ */

    /**
     * @dev Sets external PerpV2 Protocol contract addresses. Sets `collateralToken` and `collateralDecimals`
     * to the Perp vault's settlement token (USDC) and its decimals, respectively.
     *
     * @param _controller               Address of controller contract
     * @param _perpVault                Address of Perp Vault contract
     * @param _perpQuoter               Address of Perp Quoter contract
     * @param _perpMarketRegistry       Address of Perp MarketRegistry contract
     * @param _maxPerpPositionsPerSet   Max perpetual positions in one SetToken
     */
    constructor(
        IController _controller,
        IVault _perpVault,
        IQuoter _perpQuoter,
        IMarketRegistry _perpMarketRegistry,
        uint256 _maxPerpPositionsPerSet
    )
        public
        PerpV2LeverageModule(
            _controller,
            _perpVault,
            _perpQuoter,
            _perpMarketRegistry,
            _maxPerpPositionsPerSet
        )
    {}

    /**
     * @dev MANAGER ONLY: Initializes this module to the SetToken and sets fee settings. Either the SetToken needs to 
     * be on the allowed list or anySetAllowed needs to be true.
     *
     * @param _setToken             Instance of the SetToken to initialize
     */
    function initialize(
        ISetToken _setToken,
        FeeState memory _settings
    )
        external
    {
        _validateFeeState(_settings);

        // Initialize by calling PerpV2LeverageModule#initialize. 
        // Verrifies caller is manager. Verifies Set is valid, allowed and in pending state.
        super.initialize(_setToken);

        feeStates[_setToken] = _settings;
    }

    /**
     * @dev MANAGER ONLY: Allows manager to buy or sell perps to change exposure to the underlying baseToken.
     * Providing a positive value for `_baseQuantityUnits` buys vToken on UniswapV3 via Perp's ClearingHouse,
     * Providing a negative value sells the token. `_quoteBoundQuantityUnits` defines a min-receive-like slippage
     * bound for the amount of vUSDC quote asset the trade will either pay or receive as a result of the action.
     * If `_trackSettledFunding` is true, pending funding that would be settled during opening a position on Perpetual
     * protocol is added to (or subtracted from) `settledFunding[_setToken]` and can be withdrawn later by the 
     * SetToken manager.
     *
     * NOTE: This method doesn't update the externalPositionUnit because it is a function of UniswapV3 virtual
     * token market prices and needs to be generated on the fly to be meaningful.
     *
     * @param _setToken                     Instance of the SetToken
     * @param _baseToken                    Address virtual token being traded
     * @param _baseQuantityUnits            Quantity of virtual token to trade in position units
     * @param _quoteBoundQuantityUnits      Max/min of vQuote asset to pay/receive when buying or selling
     * @param _trackSettledFunding          Updates tracked settled funding if true
     */
    function tradeAndTrackFunding(
        ISetToken _setToken,
        address _baseToken,
        int256 _baseQuantityUnits,
        uint256 _quoteBoundQuantityUnits,
        bool _trackSettledFunding
    )
        external
        // nonReentrant     // fix this
    {
        // Track funding before it is settled
        _updateSettledFunding(_setToken, _trackSettledFunding);

        // Trade using PerpV2LeverageModule#trade. Verifies caller is manager and Set is valid and initialized.
        trade(
            _setToken,
            _baseToken,
            _baseQuantityUnits,
            _quoteBoundQuantityUnits
        );

    }

    function withdrawFundingAndAccrueFees(
        ISetToken _setToken,
        uint256 _amount,
        bool _trackSettledFunding
    )
        external
        nonReentrant
        onlyManagerAndValidSet(_setToken)   
    {
        _updateSettledFunding(_setToken, _trackSettledFunding);
        
        require(_amount <= settledFunding[_setToken].fromPreciseUnitToDecimals(collateralDecimals), "Withdraw amount too high");

        uint256 collateralBalanceBefore = collateralToken.balanceOf(address(_setToken));

        _withdraw(_setToken, _amount);

        (uint256 managerFee, uint256 protocolFee) = _handleFees(_setToken, _amount);
        
        _setToken.calculateAndEditDefaultPosition(
            address(collateralToken),
            _setToken.totalSupply(),
            collateralBalanceBefore
        );

        // Update settled funding
        settledFunding[_setToken] = settledFunding[_setToken].sub(_amount.toPreciseUnitsFromDecimals(collateralDecimals));

        emit FundingWithdrawn(_setToken, collateralToken, _amount, managerFee, protocolFee);
    }

    /**
     * @dev SETTOKEN ONLY: Removes this module from the SetToken, via call by the SetToken. Deletes
     * position mappings and fee states associated with SetToken. Resets settled funding to zero.
     * Fees are not accrued in case reason for removing module is related to fee accrual.
     *
     * NOTE: Function will revert if there is greater than a position unit amount of USDC of account value.
     */
    function removeModule() public override {
        super.removeModule();

        ISetToken setToken = ISetToken(msg.sender);
        
        // Not charging any fees
        delete feeStates[setToken];
        delete settledFunding[setToken];
    }

    /**
     * @dev MODULE ONLY: Hook called prior to issuance. Only callable by valid module. Should only be called ONCE
     * during issue. Trades into current positions and sets the collateralToken's externalPositionUnit so that
     * issuance module can transfer in the right amount of collateral accounting for accrued fees/pnl and slippage
     * incurred during issuance. Any pending funding payments and accrued owedRealizedPnl are attributed to current
     * Set holders. Any pending funding payment that would be settled during trading into positions on Perpetual
     * protocol is added to (or subtracted from) `settledFunding[_setToken]` and can be withdrawn later by the manager.
     *
     * @param _setToken             Instance of the SetToken
     * @param _setTokenQuantity     Quantity of Set to issue
     */
    function moduleIssueHook(
        ISetToken _setToken,
        uint256 _setTokenQuantity
    )
        public
        override
    {
        // Track funding before it is settled
        _updateSettledFunding(_setToken, true);
        
        // Validates caller is module
        super.moduleIssueHook(_setToken, _setTokenQuantity);
    }

    /**
     * @dev MODULE ONLY: Hook called prior to redemption in the issuance module. Trades out of existing
     * positions to make redemption capital withdrawable from PerpV2 vault. Sets the `externalPositionUnit`
     * equal to the realizable value of account in position units (as measured by the trade outcomes for
     * this redemption) net performance fees to be paid by the redeemer for his share of positive funding yield.
     * Any `owedRealizedPnl` and pending funding payments are socialized in this step so that redeemer 
     * pays/receives their share of them. Should only be called ONCE during redeem. Any pending funding payment 
     * that would be settled during trading out of positions on Perpetual protocol is added to (or subtracted from)
     * `settledFunding[_setToken]` and can be withdrawn later by the manager.
     *
     * @param _setToken             Instance of the SetToken
     * @param _setTokenQuantity     Quantity of SetToken to redeem
     */
    function moduleRedeemHook(
        ISetToken _setToken,
        uint256 _setTokenQuantity
    )
        external
        override
        onlyModule(_setToken)
    {
        if (_setToken.totalSupply() == 0) return;
        if (!_setToken.hasExternalPosition(address(collateralToken))) return;

        // Track funding before it is settled
        _updateSettledFunding(_setToken, true);

        int256 newExternalPositionUnit = _executePositionTrades(_setToken, _setTokenQuantity, false, false);
        
        if (settledFunding[_setToken] > 0) {
            // Calculate performance fees per Set
            uint256 performanceFeeUnit = settledFunding[_setToken]
                .preciseDiv(_setToken.totalSupply())
                .preciseMulCeil(_performanceFeePercentage(_setToken))
                .fromPreciseUnitToDecimals(collateralDecimals);
            
            newExternalPositionUnit = newExternalPositionUnit.sub(performanceFeeUnit.toInt256());
        }

        // Set USDC externalPositionUnit such that DIM can use it for transfer calculation
        _setToken.editExternalPositionUnit(
            address(collateralToken),
            address(this),
            newExternalPositionUnit
        );
    }

    /* ============ External Setter Functions ============ */

    /**
     * @dev MANAGER ONLY. Update performance fee percentage.
     *
     * @param _setToken         Instance of SetToken
     * @param _newFee           New performance fee percentage in precise units (1e16 = 1%)
     */
    function updatePerformanceFee(
        ISetToken _setToken,
        uint256 _newFee
    )
        external
        onlyManagerAndValidSet(_setToken)
    {
        require(_newFee < _maxPerformanceFeePercentage(_setToken), "Fee must be less than max");
        
        // todo: call updateSettledFunding here?
        require(settledFunding[_setToken] == 0, "Non-zero settled funding remains");

        feeStates[_setToken].performanceFeePercentage = _newFee;

        emit PerformanceFeeUpdated(_setToken, _newFee);
    }

    /**
     * @dev MANAGER ONLY. Update performance fee recipient (address to which performance fees are sent).
     *
     * @param _setToken             Instance of SetToken
     * @param _newFeeRecipient      Address of new fee recipient
     */
    function updateFeeRecipient(ISetToken _setToken, address _newFeeRecipient)
        external
        onlyManagerAndValidSet(_setToken)
    {
        require(_newFeeRecipient != address(0), "Fee Recipient must be non-zero address");

        feeStates[_setToken].feeRecipient = _newFeeRecipient;

        emit FeeRecipientUpdated(_setToken, _newFeeRecipient);
    }


    /* ============ External Getter Functions ============ */

    /**
     * @dev Gets the positive equity collateral externalPositionUnit that would be calculated for
     * redeeming a quantity of SetToken representing the amount of collateral returned per SetToken.
     * Values in the returned arrays map to the same index in the SetToken's components array.
     *
     * @param _setToken             Instance of SetToken
     * @param _setTokenQuantity     Number of sets to redeem
     *
     * @return equityAdjustments array containing a single element and an empty debtAdjustments array
     */
    function getRedemptionAdjustments(
        ISetToken _setToken,
        uint256 _setTokenQuantity
    )
        external
        override
        returns (int256[] memory, int256[] memory _)
    {
        address[] memory components = _setToken.getComponents();

        if (positions[_setToken].length > 0) {
            int256 newExternalPositionUnit = _executePositionTrades(_setToken, _setTokenQuantity, false, true);

            // Calculate performance fee unit
            uint256 performanceFeeUnit = _getUpdateSettledFunding(_setToken)
                .preciseDiv(_setToken.totalSupply())
                .preciseMulCeil(_performanceFeePercentage(_setToken))
                .fromPreciseUnitToDecimals(collateralDecimals);

            newExternalPositionUnit = newExternalPositionUnit.sub(performanceFeeUnit.toInt256());    

            return _formatAdjustments(_setToken, components, newExternalPositionUnit);
        } else {
            return _formatAdjustments(_setToken, components, 0);
        }
    }

    /* ============ Internal Functions ============ */

    /**
     * @dev Updates tracked settled funding. Once funding is settled to `owedRealizedPnl` on Perpetual protocol, it is difficult to 
     * extract out the funding value again on-chain. This function is called in an external function and is used to track and store 
     * pending funding payment that is about to be settled due to subsequent logic in the external function.
     *
     * @param _setToken             Instance of SetToken
     * @param _trackSettledFunding  Updates tracked settled funding if true
     */
    function _updateSettledFunding(ISetToken _setToken, bool _trackSettledFunding) internal {
        if (_trackSettledFunding) {
            settledFunding[_setToken] = _getUpdateSettledFunding(_setToken);
        }
    }

    /**
     * @dev Adds pending funding payment to tracked settled funding. Returns updated settled funding value.
     * 
     * NOTE: Tracked settled funding value can not be less than zero, hence it is reset to zero if pending funding
     * payment is negative and |pending funding payment| >= |settledFunding[_setToken]|.
     *
     * @param _setToken             Instance of SetToken     
     */
    function _getUpdateSettledFunding(ISetToken _setToken) internal returns (uint256) {
        // todo: Following call fetches pending funding payment across all markets. Should we change it?
        
        // NOTE: pendingFundingPayments are represented as in the Perp system as "funding owed"
        // e.g a positive number is a debt which gets subtracted from owedRealizedPnl on settlement.
        // We are flipping its sign here to reflect its settlement value.
        int256 pendingFundingToBeSettled =  perpExchange.getAllPendingFundingPayment(address(_setToken)).neg();
        
        if (pendingFundingToBeSettled > 0) {
            return settledFunding[_setToken].add(pendingFundingToBeSettled.toUint256());
        }

        if (settledFunding[_setToken] > pendingFundingToBeSettled.abs()) {
            return settledFunding[_setToken].sub(pendingFundingToBeSettled.abs()); 
        }

        return 0;
    }

    /**
     * @dev Calculates manager and protocol fees on withdranwn funding amount and transfers them to
     * their respective recipients (in USDC).
     *
     * @param _setToken     Instance of SetToken
     * @param _amount       Notional funding amount on which fees is charged
     *
     * @return managerFee      Manager performance fees
     * @return protocolFee     Protocol performance fees
     */
    function _handleFees(
        ISetToken _setToken,
        uint256 _amount
    )
        internal
        returns (uint256 managerFee, uint256 protocolFee)
    {
        uint256 performanceFee = feeStates[_setToken].performanceFeePercentage;

        if (performanceFee > 0) {
            managerFee = _amount.preciseMul(performanceFee);
            protocolFee = getModuleFee(PROTOCOL_PERFORMANCE_FEE_INDEX, _amount);

            _setToken.strictInvokeTransfer(address(collateralToken), feeStates[_setToken].feeRecipient, managerFee);
            
            payProtocolFeeFromSetToken(_setToken, address(collateralToken), protocolFee);

            return (managerFee, protocolFee);
        } else {
            return (0, 0);
        }
    }

    /**
     * @dev Validates fee settings.
     *
     * @param _settings     FeeState struct containing performance fee settings
     */
    function _validateFeeState(FeeState memory _settings) internal view {
        require(_settings.feeRecipient != address(0), "Fee Recipient must be non-zero address");
        require(_settings.maxPerformanceFeePercentage < PreciseUnitMath.preciseUnit(), "Max fee must be < 100%");
        require(_settings.performanceFeePercentage <= _settings.maxPerformanceFeePercentage, "Fee must be <= max");
    }

    /**
     * @dev Helper function that returns MAX performance fee percentage.
     *
     * @param _setToken     Instance of SetToken
     */
    function _maxPerformanceFeePercentage(ISetToken _setToken) internal view returns (uint256) {
        return feeStates[_setToken].maxPerformanceFeePercentage;
    }

    /**
     * @dev Helper function that returns performance fee percentage.
     *
     * @param _setToken     Instance of SetToken
     */
    function _performanceFeePercentage(ISetToken _setToken) internal view returns (uint256) {
        return feeStates[_setToken].performanceFeePercentage;
    }

}
