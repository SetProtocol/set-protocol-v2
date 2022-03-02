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


/**
 * @title PerpV2BasisTradingModule
 * @author Set Protocol
 * @notice 
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

    event PerformanceFeeUpdated(ISetToken indexed _setToken, uint256 _newPerformanceFee);
    event FeeRecipientUpdated(ISetToken indexed _setToken, address _newFeeRecipient);
    event FundingWithdrawn(
        ISetToken indexed  _setToken, 
        IERC20 _settlementToken, 
        uint256 _amountWithdrawn, 
        uint256 _managerFee, 
        uint256 _protocolFee
    );

    /* ============ Constants ============ */

    uint256 private constant PROTOCOL_PERFORMANCE_FEE_INDEX = 1;

    /* ============ State Variables ============ */

    mapping(ISetToken => FeeState) public feeStates;
    mapping(ISetToken => uint256) public settledFunding;

    /* ============ Constructor ============ */

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

    function initialize(
        ISetToken _setToken,
        FeeState memory _settings
    )
        external
        onlySetManager(_setToken, msg.sender)
        onlyValidAndPendingSet(_setToken)
        onlyAllowedSet(_setToken)
    {
        _validateFeeState(_settings);

        super.initialize(_setToken);

        feeStates[_setToken] = _settings;
    }

    function trade(
        ISetToken _setToken,
        address _baseToken,
        int256 _baseQuantityUnits,
        uint256 _quoteBoundQuantityUnits,
        bool _trackSettledFunding
    )
        external
        nonReentrant
        onlyManagerAndValidSet(_setToken)
    {
        super.trade(
            _setToken,
            _baseToken,
            _baseQuantityUnits,
            _quoteBoundQuantityUnits
        );

        _updateSettledFunding(_setToken, _trackSettledFunding);
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
        require(_amount <= settledFunding[_setToken], "Withdraw amount too high");

        _updateSettledFunding(_setToken, _trackSettledFunding);

        _withdraw(_setToken, _amount);

        (uint256 managerFee, uint256 protocolFee, ) = _handleFees(_setToken, _amount);

        // Fees has been transferred out
        _setToken.calculateAndEditDefaultPosition(
            address(collateralToken),
            _setToken.totalSupply(),
            collateralToken.balanceOf(address(_setToken))
        );

        // TBD: Should we do this?
        _setToken.editExternalPosition(
            address(collateralToken),
            address(this),
            _calculateExternalPositionUnit(_setToken),
            ""
        );

        // Update settled funding
        settledFunding[_setToken] = settledFunding[_setToken].sub(_amount);

        emit FundingWithdrawn(_setToken, collateralToken, _amount, managerFee, protocolFee);
    }

    function removeModule() public override {
        super.removeModule();

        ISetToken setToken = ISetToken(msg.sender);
        // Not charging any fees
        delete feeStates[setToken];
        delete settledFunding[setToken];
    }

    function moduleIssueHook(
        ISetToken _setToken,
        uint256 _setTokenQuantity
    )
        public
        override
        onlyModule(_setToken)
    {
        super.moduleIssueHook(_setToken, _setTokenQuantity);

        _updateSettledFunding(_setToken, true);
    }

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

        _updateSettledFunding(_setToken, true);

        int256 newExternalPositionUnit = _executePositionTrades(_setToken, _setTokenQuantity, false, false);

        if (settledFunding[_setToken] > 0) {
            uint256 performanceFeeUnit = settledFunding[_setToken]
                .preciseDivCeil(_setTokenQuantity)
                .preciseMul(_performanceFeePercentage(_setToken));

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

    function updatePerformanceFee(
        ISetToken _setToken,
        uint256 _newFee
    )
        external
        onlyManagerAndValidSet(_setToken)
    {
        require(_newFee < _maxPerformanceFeePercentage(_setToken), "Fee must be less than max");
        require(settledFunding[_setToken] == 0, "Non-zero settled funding remains");

        feeStates[_setToken].performanceFeePercentage = _newFee;

        emit PerformanceFeeUpdated(_setToken, _newFee);
    }

    function updateFeeRecipient(ISetToken _setToken, address _newFeeRecipient)
        external
        onlyManagerAndValidSet(_setToken)
    {
        require(_newFeeRecipient != address(0), "Fee Recipient must be non-zero address.");

        feeStates[_setToken].feeRecipient = _newFeeRecipient;

        emit FeeRecipientUpdated(_setToken, _newFeeRecipient);
    }


    /* ============ External Getter Functions ============ */

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

            // Apply funding
            int256 fundingToBeSettled =  perpExchange.getAllPendingFundingPayment(address(_setToken)).neg();

            uint256 performanceFeeUnit = settledFunding[_setToken]
                .add(fundingToBeSettled.toUint256())
                .preciseDivCeil(_setTokenQuantity)
                .preciseMul(_performanceFeePercentage(_setToken));

            newExternalPositionUnit = newExternalPositionUnit.sub(performanceFeeUnit.toInt256());    

            return _formatAdjustments(_setToken, components, newExternalPositionUnit);
        } else {
            return _formatAdjustments(_setToken, components, 0);
        }
    }

    /* ============ Internal Functions ============ */

    // Tracks settled funding across ALL markets
    function _updateSettledFunding(ISetToken _setToken, bool _trackSettledFunding) internal {
        if (_trackSettledFunding) {
            int256 fundingToBeSettled =  perpExchange.getAllPendingFundingPayment(address(_setToken)).neg();
            settledFunding[_setToken] = settledFunding[_setToken].add(fundingToBeSettled.toUint256());
        }
    }

    function _handleFees(
        ISetToken _setToken,
        uint256 _amount
    )
        internal
        returns (uint256 managerTake, uint256 protocolTake, uint256 totalFees)
    {
        uint256 performanceFee = feeStates[_setToken].performanceFeePercentage;

        if (performanceFee > 0) {
            managerTake = _amount.preciseMul(performanceFee);
            protocolTake = getModuleFee(PROTOCOL_PERFORMANCE_FEE_INDEX, _amount);
            totalFees = managerTake.add(protocolTake);

            _setToken.strictInvokeTransfer(address(collateralToken), feeStates[_setToken].feeRecipient, managerTake);
            
            payProtocolFeeFromSetToken(_setToken, address(collateralToken), protocolTake);

            return (managerTake, protocolTake, totalFees);
        } else {
            return (0, 0, 0);
        }
    }

    function _validateFeeState(FeeState memory _settings) internal view {
        require(_settings.feeRecipient != address(0), "Fee Recipient must be non-zero address.");
        require(_settings.maxPerformanceFeePercentage < PreciseUnitMath.preciseUnit(), "Max fee must be < 100%.");
        require(_settings.performanceFeePercentage <= _settings.maxPerformanceFeePercentage, "Fee must be <= max.");
    }

    function _maxPerformanceFeePercentage(ISetToken _set) internal view returns (uint256) {
        return feeStates[_set].maxPerformanceFeePercentage;
    }

    function _performanceFeePercentage(ISetToken _set) internal view returns (uint256) {
        return feeStates[_set].maxPerformanceFeePercentage;
    }

}
