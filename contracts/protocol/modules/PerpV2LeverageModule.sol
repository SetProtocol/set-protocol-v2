/*
    Copyright 2021 Set Labs Inc.

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
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { FixedPoint96 } from "@uniswap/v3-core/contracts/libraries/FixedPoint96.sol";
import { FullMath } from "@uniswap/v3-core/contracts/libraries/FullMath.sol";


import { PerpV2 } from "../integration/lib/PerpV2.sol";
import { IAccountBalance } from "../../interfaces/external/perp-v2/IAccountBalance.sol";
import { IClearingHouse } from "../../interfaces/external/perp-v2/IClearingHouse.sol";
import { IExchange } from "../../interfaces/external/perp-v2/IExchange.sol";
import { IVault } from "../../interfaces/external/perp-v2/IVault.sol";
import { IQuoter } from "../../interfaces/external/perp-v2/IQuoter.sol";
import { IController } from "../../interfaces/IController.sol";
import { IDebtIssuanceModule } from "../../interfaces/IDebtIssuanceModule.sol";
import { IModuleIssuanceHook } from "../../interfaces/IModuleIssuanceHook.sol";
import { ISetToken } from "../../interfaces/ISetToken.sol";
import { ModuleBase } from "../lib/ModuleBase.sol";
import { PreciseUnitMath } from "../../lib/PreciseUnitMath.sol";
import { AddressArrayUtils } from "../../lib/AddressArrayUtils.sol";

// TODO: REMOVE THIS WHEN COMPLETE
import "hardhat/console.sol";

/**
 * @title PerpLeverageModule
 * @author Set Protocol
 * @notice Smart contract that enables leverage trading using Aave as the lending protocol.
 * @dev Do not use this module in conjunction with other debt modules that allow Aave debt positions as it could lead to double counting of
 * debt when borrowed assets are the same.
 */
contract PerpV2LeverageModule is ModuleBase, ReentrancyGuard, Ownable, IModuleIssuanceHook {
    using PerpV2 for ISetToken;
    using PreciseUnitMath for int256;
    using AddressArrayUtils for address[];

    /* ============ Structs ============ */

    struct ActionInfo {
        ISetToken setToken;
        address baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        int256 amount;
        uint256 oppositeAmountBound;
        int256 preTradeQuoteBalance;
    }

    struct PositionInfo {
        address baseToken;
        int256 baseBalance;
        int256 quoteBalance;
    }

    struct AccountInfo {
        int256 collateralBalance;
        int256 owedRealizedPnL;
        int256 pendingFundingPayments;
        int256 accountValue;
        uint256 totalAbsPositionValue;
        int256 netQuoteBalance;
        // Missing....
        // int256 marginRequirement;
        // uint256 freeCollateral;
    }

    /* ============ Events ============ */

    event LeverageIncreased(
        ISetToken indexed _setToken,
        address indexed _baseToken,
        uint256 _deltaBase,
        uint256 _deltaQuote,
        uint256 _protocolFee
    );

    event LeverageDecreased(
        ISetToken indexed _setToken,
        address indexed _baseToken,
        uint256 _deltaBase,
        uint256 _deltaQuote,
        uint256 _protocolFee
    );

    /**
     * @dev Emitted on updateAllowedSetToken()
     * @param _setToken SetToken being whose allowance to initialize this module is being updated
     * @param _added    true if added false if removed
     */
    event SetTokenStatusUpdated(
        ISetToken indexed _setToken,
        bool indexed _added
    );

    /**
     * @dev Emitted on updateAnySetAllowed()
     * @param _anySetAllowed    true if any set is allowed to initialize this module, false otherwise
     */
    event AnySetAllowedUpdated(
        bool indexed _anySetAllowed
    );

    /* ============ Constants ============ */

    // String identifying the DebtIssuanceModule in the IntegrationRegistry. Note: Governance must add DefaultIssuanceModule as
    // the string as the integration name
    string constant internal DEFAULT_ISSUANCE_MODULE_NAME = "DefaultIssuanceModule";

    // 0 index stores protocol fee % on the controller, charged in the _executeTrade function
    uint256 constant internal PROTOCOL_TRADE_FEE_INDEX = 0;

    /* ============ State Variables ============ */

    IAccountBalance public immutable perpAccountBalance;

    IClearingHouse public immutable perpClearingHouse;

    IExchange public immutable perpExchange;

    IVault public immutable perpVault;

    IQuoter public immutable perpQuoter;

    mapping(ISetToken => address[]) public positions;

    mapping(ISetToken => IERC20) public collateralToken;

    // Mapping of SetToken to boolean indicating if SetToken is on allow list. Updateable by governance
    mapping(ISetToken => bool) public allowedSetTokens;

    // Boolean that returns if any SetToken can initialize this module. If false, then subject to allow list. Updateable by governance.
    bool public anySetAllowed;

    /* ============ Constructor ============ */

    constructor(
        IController _controller,
        IAccountBalance _perpAccountBalance,
        IClearingHouse _perpClearingHouse,
        IExchange _perpExchange,
        IVault _perpVault,
        IQuoter _perpQuoter
    )
        public
        ModuleBase(_controller)
    {
        perpAccountBalance = _perpAccountBalance;
        perpClearingHouse = _perpClearingHouse;
        perpExchange = _perpExchange;
        perpVault = _perpVault;
        perpQuoter = _perpQuoter;
    }

    /* ============ External Functions ============ */

    function lever(
        ISetToken _setToken,
        address _baseToken,
        int256 _baseQuantityUnits,
        uint256 _receiveQuoteQuantityUnits
    )
        external
        nonReentrant
        onlyManagerAndValidSet(_setToken)
    {
        ActionInfo memory actionInfo = _createAndValidateActionInfo(
            _setToken,
            _baseToken,
            _baseQuantityUnits,
            _receiveQuoteQuantityUnits
        );

        (uint256 deltaBase, uint256 deltaQuote) = _executeTrade(actionInfo);

        // TODO: Double-check deltas? Can we trust oppositeBoundAmount?

        uint256 protocolFee = _accrueProtocolFee(_setToken, deltaQuote);

        // TODO: Update externalPositionUnit for collateralToken ?

        _updatePositionList(_setToken, _baseToken);

        emit LeverageIncreased(
            _setToken,
            _baseToken,
            deltaBase,
            deltaQuote,
            protocolFee
        );
    }


    function delever(
        ISetToken _setToken,
        address _baseToken,
        int256 _baseQuantityUnits,
        uint256 _receiveQuoteQuantityUnits
    )
        external
        nonReentrant
        onlyManagerAndValidSet(_setToken)
    {
        ActionInfo memory actionInfo = _createAndValidateActionInfo(
            _setToken,
            _baseToken,
            _baseQuantityUnits.mul(-1),
            _receiveQuoteQuantityUnits
        );

        (uint256 deltaBase, uint256 deltaQuote) = _executeTrade(actionInfo);

        // TODO: Double-check deltas? Can we trust oppositeBoundAmount?

        uint256 protocolFee = _accrueProtocolFee(_setToken, deltaQuote);

        // TODO: Update externalPositionUnit for collateralToken ?

        _updatePositionList(_setToken, _baseToken);

        emit LeverageDecreased(
            _setToken,
            _baseToken,
            deltaBase,
            deltaQuote,
            protocolFee
        );
    }

    function deposit(
      ISetToken _setToken,
      uint256 _collateralQuantityUnits
    )
      public
      nonReentrant
      onlyManagerAndValidSet(_setToken)
    {
        _deposit(_setToken, _collateralQuantityUnits);
    }

    function withdraw(
      ISetToken _setToken,
      uint256 _collateralQuantityUnits
    )
      public
      nonReentrant
      onlyManagerAndValidSet(_setToken)
    {
        require(_collateralQuantityUnits > 0, "Withdraw amount is 0");
        _withdraw(_setToken, _collateralQuantityUnits, true);
    }

    function initialize(
        ISetToken _setToken,
        IERC20 _collateralToken
    )
        external
        onlySetManager(_setToken, msg.sender)
        onlyValidAndPendingSet(_setToken)
    {
        if (!anySetAllowed) {
            require(allowedSetTokens[_setToken], "Not allowed SetToken");
        }

        // Initialize module before trying register
        _setToken.initializeModule();

        // Get debt issuance module registered to this module and require that it is initialized
        require(_setToken.isInitializedModule(
            getAndValidateAdapter(DEFAULT_ISSUANCE_MODULE_NAME)),
            "Issuance not initialized"
        );

        // Try if register exists on any of the modules including the debt issuance module
        address[] memory modules = _setToken.getModules();
        for(uint256 i = 0; i < modules.length; i++) {
            try IDebtIssuanceModule(modules[i]).registerToIssuanceModule(_setToken) {} catch {}
        }

        // Set collateralToken
        _setCollateralToken(_setToken, _collateralToken);
    }


    function removeModule() external override onlyValidAndInitializedSet(ISetToken(msg.sender)) {
        ISetToken setToken = ISetToken(msg.sender);
        require(_getCollateralBalance(setToken) == 0, "Collateral balance remaining");

        delete positions[setToken]; // Should already be empty
        delete collateralToken[setToken];

        // Try if unregister exists on any of the modules
        address[] memory modules = setToken.getModules();
        for(uint256 i = 0; i < modules.length; i++) {
            try IDebtIssuanceModule(modules[i]).unregisterFromIssuanceModule(setToken) {} catch {}
        }
    }

    /**
     * @dev MANAGER ONLY: Add registration of this module on the debt issuance module for the SetToken.
     * Note: if the debt issuance module is not added to SetToken before this module is initialized, then this function
     * needs to be called if the debt issuance module is later added and initialized to prevent state inconsistencies
     * @param _setToken             Instance of the SetToken
     * @param _debtIssuanceModule   Debt issuance module address to register
     */
    function registerToModule(ISetToken _setToken, IDebtIssuanceModule _debtIssuanceModule) external onlyManagerAndValidSet(_setToken) {
        require(_setToken.isInitializedModule(address(_debtIssuanceModule)), "Issuance not initialized");

        _debtIssuanceModule.registerToIssuanceModule(_setToken);
    }

    /**
     * @dev GOVERNANCE ONLY: Enable/disable ability of a SetToken to initialize this module. Only callable by governance.
     * @param _setToken             Instance of the SetToken
     * @param _status               Bool indicating if _setToken is allowed to initialize this module
     */
    function updateAllowedSetToken(ISetToken _setToken, bool _status) external onlyOwner {
        require(controller.isSet(address(_setToken)) || allowedSetTokens[_setToken], "Invalid SetToken");
        allowedSetTokens[_setToken] = _status;
        emit SetTokenStatusUpdated(_setToken, _status);
    }

    /**
     * @dev GOVERNANCE ONLY: Toggle whether ANY SetToken is allowed to initialize this module. Only callable by governance.
     * @param _anySetAllowed             Bool indicating if ANY SetToken is allowed to initialize this module
     */
    function updateAnySetAllowed(bool _anySetAllowed) external onlyOwner {
        anySetAllowed = _anySetAllowed;
        emit AnySetAllowedUpdated(_anySetAllowed);
    }

    function setCollateralToken(
      ISetToken _setToken,
      IERC20 _collateralToken
    )
      external
      onlyManagerAndValidSet(ISetToken(_setToken))
    {
        _setCollateralToken(_setToken, _collateralToken);
    }


    function moduleIssueHook(
        ISetToken _setToken,
        uint256 _setTokenQuantity
    )
        external
        override
        onlyModule(_setToken)
    {
        int256 usdcAmountIn = 0;

        PositionInfo[] memory positionInfo = getPositionInfo(_setToken);

        for(uint i = 0; i < positionInfo.length; i++) {
            int256 basePositionUnit = positionInfo[i].baseBalance.preciseDiv(_setToken.totalSupply().toInt256());
            int256 baseTradeNotionalQuantity = _abs(basePositionUnit.preciseMul(_setTokenQuantity.toInt256()));

            // Simulate trade to get its real cost
            ActionInfo memory actionInfo = _createAndValidateActionInfo(
                _setToken,
                positionInfo[i].baseToken,
                baseTradeNotionalQuantity,
                0
            );

            IQuoter.SwapResponse memory swapResponse = _simulateTrade(actionInfo);

            usdcAmountIn += _calculateUSDCAmountIn(
                _setToken,
                _setTokenQuantity,
                baseTradeNotionalQuantity,
                basePositionUnit,
                positionInfo[i],
                swapResponse.deltaAvailableQuote
            );
        }

        // Set USDC externalPositionUnit such that DIM can use it for transfer calculation
        int256 newExternalPositionUnit = usdcAmountIn.preciseDiv(_setTokenQuantity.toInt256());

        _setToken.editExternalPositionUnit(
            address(collateralToken[_setToken]),
            address(this),
            newExternalPositionUnit
        );
    }


    function moduleRedeemHook(
        ISetToken _setToken,
        uint256 _setTokenQuantity
    )
        external
        override
        onlyModule(_setToken)
    {
        int256 realizedPnL = 0;
        int256 setTokenQuantity = _setTokenQuantity.toInt256();

        PositionInfo[] memory positionInfo = getPositionInfo(_setToken);
        AccountInfo memory accountInfo = getAccountInfo(_setToken);

        // Calculate already accrued PnL from non-issuance/redemption sources (ex: levering)
        int256 totalFundingAndCarriedPnL = accountInfo.pendingFundingPayments + accountInfo.owedRealizedPnL;
        int256 owedRealizedPnLPositionUnit = totalFundingAndCarriedPnL.preciseDiv(_setToken.totalSupply().toInt256());

        for (uint256 i = 0; i < positionInfo.length; i++) {
            // Calculate amount to trade
            int256 basePositionUnit = positionInfo[i].baseBalance.preciseDiv(_setToken.totalSupply().toInt256());
            int256 baseTradeNotionalQuantity = _abs(setTokenQuantity.preciseMul(basePositionUnit));

            // Calculate amount quote debt will be reduced by
            int256 closeRatio = baseTradeNotionalQuantity.preciseDiv(positionInfo[i].baseBalance);
            int256 reducedOpenNotional = positionInfo[i].quoteBalance.preciseMul(closeRatio);

            // Trade
            ActionInfo memory actionInfo = _createAndValidateActionInfo(
                _setToken,
                positionInfo[i].baseToken,
                baseTradeNotionalQuantity,
                0
            );

            (,uint256 deltaQuote) = _executeTrade(actionInfo);

            // Calculate realized PnL for and add to running total.
            // When basePositionUnit is positive, position is long.
            if (basePositionUnit >= 0){
                realizedPnL += reducedOpenNotional + deltaQuote.toInt256();
            } else {
                realizedPnL += reducedOpenNotional - deltaQuote.toInt256();
            }
        }

        // Calculate amount of USDC to withdraw
        int256 collateralPositionUnit = _getCollateralBalance(_setToken).preciseDiv(_setToken.totalSupply().toInt256());

        int256 usdcToWithdraw =
            collateralPositionUnit.preciseMul(setTokenQuantity) +
            owedRealizedPnLPositionUnit.preciseMul(setTokenQuantity) +
            realizedPnL;

        // Set the external position unit for DIM
        _setToken.editExternalPosition(
            address(collateralToken[_setToken]),
            address(this),
            usdcToWithdraw.preciseDiv(setTokenQuantity),
            ""
        );
    }


    function componentIssueHook(
        ISetToken _setToken,
        uint256 _setTokenQuantity,
        IERC20 _component,
        bool /* isEquity */
    )
        external
        override
        onlyModule(_setToken)
    {
        // Deposit collateral from SetToken into PerpV2
        int256 externalPositionUnit = _setToken.getExternalPositionRealUnit(address(_component), address(this));
        uint256 usdcTransferInQuantityUnits = _setTokenQuantity.preciseMul(externalPositionUnit.toUint256());
        _deposit(_setToken, usdcTransferInQuantityUnits);

        PositionInfo[] memory positionInfo = getPositionInfo(_setToken);

        for(uint i = 0; i < positionInfo.length; i++) {
            int256 basePositionUnit = positionInfo[i].baseBalance.preciseDiv(_setToken.totalSupply().toInt256());
            int256 baseTradeNotionalQuantity = _abs(_setTokenQuantity.toInt256().preciseMul(basePositionUnit));

            ActionInfo memory actionInfo = _createAndValidateActionInfo(
                _setToken,
                positionInfo[i].baseToken,
                baseTradeNotionalQuantity,
                0
            );

            _executeTrade(actionInfo);
        }
    }

    function componentRedeemHook(
        ISetToken _setToken,
        uint256 _setTokenQuantity,
        IERC20 _component,
        bool /* isEquity */
    ) external override onlyModule(_setToken) {
        int256 externalPositionUnit = _setToken.getExternalPositionRealUnit(address(_component), address(this));
        uint256 usdcTransferOutQuantityUnits = _setTokenQuantity.preciseMul(externalPositionUnit.toUint256());
        _withdraw(_setToken, usdcTransferOutQuantityUnits, false);
    }

    /* ============ External Getter Functions ============ */

    function getPositionInfo(ISetToken _setToken) public view returns (PositionInfo[] memory) {
        PositionInfo[] memory positionInfo = new PositionInfo[](positions[_setToken].length);

        for(uint i = 0; i < positions[_setToken].length; i++){
            positionInfo[i] = PositionInfo({
                baseToken: positions[_setToken][i],
                baseBalance: perpAccountBalance.getBase(
                    address(_setToken),
                    positions[_setToken][i]
                ),
                quoteBalance: perpAccountBalance.getQuote(
                    address(_setToken),
                    positions[_setToken][i]
                )
            });
        }

        return positionInfo;
    }

    function getAccountInfo(ISetToken _setToken) public view returns (AccountInfo memory accountInfo) {
        accountInfo = AccountInfo({
            collateralBalance: _getCollateralBalance(_setToken),
            owedRealizedPnL: perpAccountBalance.getOwedRealizedPnl(address(_setToken)),
            pendingFundingPayments: perpExchange.getAllPendingFundingPayment(address(_setToken)),

            // TODO: think this is also in "settlement decimals"
            accountValue: perpClearingHouse.getAccountValue(address(_setToken)),

            totalAbsPositionValue: perpAccountBalance.getTotalAbsPositionValue(address(_setToken)),
            netQuoteBalance: perpAccountBalance.getNetQuoteBalance(address(_setToken))

            // Missing....
            //freeCollateral: perpVault.getFreeCollateral(address(_setToken))
        });
    }

    function getSpotPrice(address _baseToken) public view returns (uint256 price) {
        address pool = perpExchange.getPool(_baseToken);
        (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3Pool(pool).slot0();
        uint256 priceX96 = _formatSqrtPriceX96ToPriceX96(sqrtPriceX96);
        return _formatX96ToX10_18(priceX96);
    }

    /* ============ Internal Functions ============ */

    function _deposit(ISetToken _setToken, uint256 _collateralQuantityUnits) internal {
        uint256 initialCollateralPositionBalance = collateralToken[_setToken].balanceOf(address(_setToken));
        uint256 notionalCollateralQuantity = _formatCollateralQuantityUnits(_setToken, _collateralQuantityUnits);

        _setToken.invokeApprove(
            address(collateralToken[_setToken]),
            address(perpVault),
            notionalCollateralQuantity
        );

        _setToken.invokeDeposit(perpVault, collateralToken[_setToken], notionalCollateralQuantity);

        _setToken.calculateAndEditDefaultPosition(
            address(collateralToken[_setToken]),
            _setToken.totalSupply(),
            initialCollateralPositionBalance
        );

        // TODO: Update externalPositionUnit for collateralToken ?
    }

    function _withdraw(ISetToken _setToken, uint256 _collateralQuantityUnits, bool editDefaultPosition) internal {
        if (_collateralQuantityUnits == 0) return;

        uint256 initialCollateralPositionBalance = collateralToken[_setToken].balanceOf(address(_setToken));
        uint256 notionalCollateralQuantity = _formatCollateralQuantityUnits(_setToken, _collateralQuantityUnits);

        _setToken.invokeWithdraw(perpVault, collateralToken[_setToken], notionalCollateralQuantity);

        // Skip position editing in cases (like fee payment) where we withdraw and immediately
        // forward the amount to another recipient.
        if (editDefaultPosition) {
            _setToken.calculateAndEditDefaultPosition(
                address(collateralToken[_setToken]),
                _setToken.totalSupply(),
                initialCollateralPositionBalance
            );
        }

        // TODO: Update externalPositionUnit for collateralToken ?
    }


    function _executeTrade(ActionInfo memory _actionInfo) internal returns (uint256, uint256) {
        IClearingHouse.OpenPositionParams memory params = IClearingHouse.OpenPositionParams({
            baseToken: _actionInfo.baseToken,
            isBaseToQuote: _actionInfo.isBaseToQuote,
            isExactInput: _actionInfo.isExactInput,
            amount: _actionInfo.amount.toUint256(),
            oppositeAmountBound: _actionInfo.oppositeAmountBound,
            deadline: PreciseUnitMath.maxUint256(),
            sqrtPriceLimitX96: 0,
            referralCode: bytes32(0)
        });

        return _actionInfo.setToken.invokeOpenPosition(perpClearingHouse, params);
    }

    function _simulateTrade(ActionInfo memory _actionInfo) internal returns (IQuoter.SwapResponse memory) {
        IQuoter.SwapParams memory params = IQuoter.SwapParams({
            baseToken: _actionInfo.baseToken,
            isBaseToQuote: _actionInfo.isBaseToQuote,
            isExactInput: _actionInfo.isExactInput,
            amount: _actionInfo.amount.toUint256(),
            sqrtPriceLimitX96: 0
        });

        return _actionInfo.setToken.invokeSwap(perpQuoter, params);
    }

    function _accrueProtocolFee(
        ISetToken _setToken,
        uint256 _exchangedQuantity
    )
        internal
        returns(uint256)
    {
        IERC20 token = collateralToken[_setToken];

        uint256 protocolFee = getModuleFee(PROTOCOL_TRADE_FEE_INDEX, _exchangedQuantity);
        uint256 protocolFeeUnits = protocolFee.preciseDiv(_setToken.totalSupply());

        _withdraw(_setToken, protocolFeeUnits, false);

        uint256 protocolFeeInCollateralDecimals = _formatCollateralToken(
            protocolFee,
            ERC20(address(token)).decimals()
        );

        payProtocolFeeFromSetToken(_setToken, address(token), protocolFeeInCollateralDecimals);

        return protocolFeeInCollateralDecimals;
    }

    function _createAndValidateActionInfo(
        ISetToken _setToken,
        address _baseToken,
        int256 _baseTokenQuantityUnits,
        uint256 _minReceiveQuantityUnits
    )
        internal
        view
        returns(ActionInfo memory)
    {
        uint256 totalSupply = _setToken.totalSupply();

        return _createAndValidateActionInfoNotional(
            _setToken,
            _baseToken,
            _baseTokenQuantityUnits.preciseMul(totalSupply.toInt256()),
            _minReceiveQuantityUnits.preciseMul(totalSupply)
        );
    }

    /*

    | --------------------------------------------------------------------------------------------------|
    | Action |  Type | isB2Q | Exact In / Out | Amount    | minReceived   | minReceived description     |
    | -------|-------|-------|----------------|-----------| ------------- | ----------------------------|
    | Buy    | Long  | false | exact output   | baseToken | quoteToken    | upper bound of input quote  |
    | Buy    | Short | true  | exact input    | baseToken | quoteToken    | lower bound of output quote |
    | Sell   | Long  | true  | exact input    | baseToken | quoteToken    | lower bound of output quote |
    | Sell   | Short | false | exact output   | baseToken | quoteToken    | upper bound of input quote  |
    |---------------------------------------------------------------------------------------------------|

    */

    function _createAndValidateActionInfoNotional(
        ISetToken _setToken,
        address _baseToken,
        int256 _notionalBaseTokenQuantity,
        uint256 _minNotionalQuoteReceiveQuantity
    )
        internal
        view
        returns(ActionInfo memory)
    {
        bool isShort = _notionalBaseTokenQuantity < 0;

        ActionInfo memory actionInfo = ActionInfo ({
            setToken: _setToken,
            baseToken: _baseToken,
            isBaseToQuote: isShort,
            isExactInput: isShort,
            amount: _abs(_notionalBaseTokenQuantity),
            oppositeAmountBound: _minNotionalQuoteReceiveQuantity,
            preTradeQuoteBalance: IAccountBalance(perpAccountBalance).getQuote(
                address(_setToken),
                _baseToken
            )
        });

        _validateCommon(actionInfo);

        return actionInfo;
    }

    function _updatePositionList(ISetToken _setToken, address _baseToken) internal {
        int256 baseBalance = perpAccountBalance.getBase(address(_setToken), _baseToken);

        // TODO: Add storage variants of contains, indexOf to AddressArrayUtils ?
        address[] memory positionList = positions[_setToken];
        bool baseTokenExists = positionList.contains(_baseToken);

        if (baseTokenExists && baseBalance == 0) {
            positions[_setToken].removeStorage(_baseToken);
        }  else if (!baseTokenExists) {
            positions[_setToken].push(_baseToken);
        }
    }

    function _calculateUSDCAmountIn(
        ISetToken _setToken,
        uint256 _setTokenQuantity,
        int256 _baseTradeQuantity,
        int256 _basePositionUnit,
        PositionInfo memory _positionInfo,
        uint256 _deltaQuote
    )
        internal
        view
        returns(int256)
    {
        // Calculate ideal quote cost e.g without slippage and Perp protocol fees
        int256 spotPrice = getSpotPrice(_positionInfo.baseToken).toInt256();
        int256 idealDeltaQuote = _baseTradeQuantity.preciseMul(spotPrice);

        // Calculate slippage for long and short cases
        int256 slippageQuantity = (_basePositionUnit >= 0)
            ? _deltaQuote.toInt256() - idealDeltaQuote
            : idealDeltaQuote - _deltaQuote.toInt256();

        // Calculate current leverage
        int256 currentLeverage = _calculateCurrentLeverage(
            _positionInfo.baseBalance,
            _positionInfo.quoteBalance,
            _getCollateralBalance(_setToken),
            spotPrice
        );

        int256 owedRealizedPnlDiscountQuantity = _calculateOwedRealizedPnLDiscount(
            _setToken,
            _setTokenQuantity
        );

        return (
            slippageQuantity +
            owedRealizedPnlDiscountQuantity +
            _deltaQuote.toInt256().preciseDiv(currentLeverage)
        );
    }

    function _calculateOwedRealizedPnLDiscount(
        ISetToken _setToken,
        uint256 _setTokenQuantity
    )
        internal
        view
        returns (int256)
    {
        // Calculate addtional usdcAmountIn and add to running total.
        int256 owedRealizedPnL = perpAccountBalance.getOwedRealizedPnl(address(_setToken));
        int256 pendingFundingPayments = perpExchange.getAllPendingFundingPayment(address(_setToken));

        return (owedRealizedPnL + pendingFundingPayments)
            .preciseDiv(_setToken.totalSupply().toInt256())
            .preciseMul(_setTokenQuantity.toInt256());
    }

    function _calculateCurrentLeverage(
        int256 baseBalance,
        int256 quoteBalance,
        int256 collateralBalance,
        int256 spotPrice
    )
        internal
        pure
        returns (int256)
    {
        int256 basePositionValue = baseBalance.preciseMul(spotPrice);

        return basePositionValue.preciseDiv(
            basePositionValue +
            quoteBalance +
            collateralBalance
        );
    }

    function _setCollateralToken(
      ISetToken _setToken,
      IERC20 _collateralToken
    )
      internal
    {
        require(perpVault.balanceOf(address(_setToken)) == 0);
        collateralToken[_setToken] = _collateralToken;
    }

    /**
     * @dev Validate common requirements for lever and delever
     */
    function _validateCommon(ActionInfo memory _actionInfo) internal pure {
        // TODO: other validations....
        require(_actionInfo.amount > 0, "Amount is 0");
    }

    /**
     * @dev Validates if a new asset can be added as collateral asset for given SetToken
     */
    function _validateNewCollateralAsset(ISetToken _setToken, IERC20 _asset) internal view {
        // TODO:
        // require collateral is a default component on SetToken
        // require collateral is valid for deposit in PerpV2
    }


    // TODO: Add logic here to convert non-USDC collateral into USDC
    function _getCollateralBalance(ISetToken _setToken) internal view returns (int256) {
        int256 balance = perpVault.balanceOf(address(_setToken));
        uint8 decimals = ERC20(address(collateralToken[_setToken])).decimals();
        return _parseCollateralToken(balance, decimals);
    }

    function _formatCollateralQuantityUnits(
        ISetToken _setToken,
        uint256 _collateralQuantityUnits
    )
        internal
        view
        returns (uint256)
    {
        uint256 notionalQuantity = _collateralQuantityUnits.preciseMul(_setToken.totalSupply());

        uint8 decimals = ERC20(address(collateralToken[_setToken])).decimals();

        return _formatCollateralToken(
            notionalQuantity,
            decimals
        );
    }

    function _formatSqrtPriceX96ToPriceX96(uint160 sqrtPriceX96) internal pure returns (uint256) {
        return FullMath.mulDiv(sqrtPriceX96, sqrtPriceX96, FixedPoint96.Q96);
    }

    function _formatX96ToX10_18(uint256 valueX96) internal pure returns (uint256) {
        return FullMath.mulDiv(valueX96, 1 ether, FixedPoint96.Q96);
    }

    function _formatCollateralToken(uint256 amount, uint8 decimals) internal pure returns (uint256) {
        return amount.div(10**(18 - uint(decimals)));
    }

    function _parseCollateralToken(int256 amount, uint8 decimals) internal pure returns (int256) {
        return amount.mul(int256(10**(18 - uint(decimals))));
    }

    function _abs(int x) internal pure returns (int) {
        return x >= 0 ? x : -x;
    }
}