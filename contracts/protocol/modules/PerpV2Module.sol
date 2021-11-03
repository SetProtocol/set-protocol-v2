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
import { IController } from "../../interfaces/IController.sol";
import { IDebtIssuanceModule } from "../../interfaces/IDebtIssuanceModule.sol";
import { IModuleIssuanceHook } from "../../interfaces/IModuleIssuanceHook.sol";
import { ISetToken } from "../../interfaces/ISetToken.sol";
import { ModuleBase } from "../lib/ModuleBase.sol";
import { PreciseUnitMath } from "../../lib/PreciseUnitMath.sol";


/**
 * @title AaveLeverageModule
 * @author Set Protocol
 * @notice Smart contract that enables leverage trading using Aave as the lending protocol.
 * @dev Do not use this module in conjunction with other debt modules that allow Aave debt positions as it could lead to double counting of
 * debt when borrowed assets are the same.
 */
contract PerpLeverageModule is ModuleBase, ReentrancyGuard, Ownable, IModuleIssuanceHook {
    using PerpV2 for ISetToken;
    using PreciseUnitMath for int256;

    /* ============ Structs ============ */

    struct ActionInfo {
        ISetToken setToken;
        IERC20 baseToken;
        bool isBaseToQuote;
        bool isExactInput;
        int256 amount;
        uint256 oppositeAmountBound;
        int256 preTradeQuoteBalance;
    }

    struct PositionInfo {
        IERC20 baseToken;
        int256 baseBalance;
        int256 quoteBalance;
    }

    struct AccountInfo {
        int256 collateralBalance;
        int256 owedRealizedPnL;
        int256 pendingFundingPayments;
        int256 accountValue;
        int256 marginRequirement;
        // Missing....
        // uint256 freeCollateral;
    }

    /* ============ Events ============ */

    event LeverageIncreased(
        ISetToken indexed _setToken,
        IERC20 indexed _baseToken,
        uint256 _deltaBase,
        uint256 _deltaQuote,
        uint256 _protocolFee
    );

    event LeverageDecreased(
        ISetToken indexed _setToken,
        IERC20 indexed _baseToken,
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

    mapping(ISetToken => PositionInfo[]) public positions;

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
        IVault _perpVault
    )
        public
        ModuleBase(_controller)
    {
        perpAccountBalance = _perpAccountBalance;
        perpClearingHouse = _perpClearingHouse;
        perpExchange = _perpExchange;
        perpVault = _perpVault;
    }

    /* ============ External Functions ============ */

    function lever(
        ISetToken _setToken,
        IERC20 _baseToken,
        int256 _baseQuantityUnits,
        uint256 _minReceiveQuantityUnits
    )
        external
        nonReentrant
        onlyManagerAndValidSet(_setToken)
    {
        ActionInfo memory actionInfo = _createAndValidateActionInfo(
            _setToken,
            _baseToken,
            _baseQuantityUnits,
            _minReceiveQuantityUnits
        );

        (uint256 deltaBase, uint256 deltaQuote) = _executeTrade(actionInfo);

        // TODO: Double-check deltas? Can we trust oppositeBoundAmount?

        uint256 protocolFee = _accrueProtocolFee(_setToken, deltaQuote);

        // TODO: Update externalPositionUnit for collateralToken ?

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
        IERC20 _baseToken,
        int256 _baseQuantityUnits,
        uint256 _minReceiveQuantityUnits
    )
        external
        nonReentrant
        onlyManagerAndValidSet(_setToken)
    {
        ActionInfo memory actionInfo = _createAndValidateActionInfo(
            _setToken,
            _baseToken,
            _baseQuantityUnits,
            _minReceiveQuantityUnits
        );

        (uint256 deltaBase, uint256 deltaQuote) = _executeTrade(actionInfo);

        // TODO: Double-check deltas? Can we trust oppositeBoundAmount?

        uint256 protocolFee = _accrueProtocolFee(_setToken, deltaQuote);

        // TODO: Update externalPositionUnit for collateralToken ?

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
      external
      nonReentrant
      onlyManagerAndValidSet(_setToken)
    {
        uint256 notionalCollateralQuantity = _formatCollateralQuantityUnits(_setToken, _collateralQuantityUnits);

        _setToken.invokeApprove(
            address(collateralToken[_setToken]),
            address(perpVault),
            notionalCollateralQuantity
        );

        _setToken.invokeDeposit(perpVault, collateralToken[_setToken], notionalCollateralQuantity);


        uint256 newDefaultTokenUnit = _setToken
            .getDefaultPositionRealUnit(address(collateralToken[_setToken]))
            .toUint256()
            .sub(_collateralQuantityUnits);

        _setToken.editDefaultPosition(address(collateralToken[_setToken]), newDefaultTokenUnit);

        // TODO: Update externalPositionUnit for collateralToken ?
    }

    function withdraw(
      ISetToken _setToken,
      uint256 _collateralQuantityUnits
    )
      public // compiler visibility...
      nonReentrant
      onlyManagerAndValidSet(_setToken)
    {
        uint256 notionalCollateralQuantity = _formatCollateralQuantityUnits(_setToken, _collateralQuantityUnits);

        _setToken.invokeWithdraw(perpVault, collateralToken[_setToken], notionalCollateralQuantity);

        uint256 newDefaultTokenUnit = _setToken
            .getDefaultPositionRealUnit(address(collateralToken[_setToken]))
            .toUint256()
            .add(_collateralQuantityUnits);

        _setToken.editDefaultPosition(address(collateralToken[_setToken]), newDefaultTokenUnit);

        // TODO: Update externalPositionUnit for collateralToken ?
    }

    function setCollateralToken(
      ISetToken _setToken,
      IERC20 _collateralToken
    )
      public // compiler visibility...
      onlyManagerAndValidSet(ISetToken(_setToken))
    {
        require(perpVault.balanceOf(address(_setToken)) == 0);
        collateralToken[_setToken] = _collateralToken;
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
        setCollateralToken(_setToken, _collateralToken);
    }


    function removeModule() external override onlyValidAndInitializedSet(ISetToken(msg.sender)) {
        ISetToken setToken = ISetToken(msg.sender);
        require(_getCollateralBalance(setToken) == 0);

        delete positions[setToken];
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


    function moduleIssueHook(ISetToken _setToken, uint256 _setTokenQuantity) external override onlyModule(_setToken) {
        // WIP
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
    ) external override onlyModule(_setToken) {
        // WIP
    }


    function componentRedeemHook(
        ISetToken _setToken,
        uint256 _setTokenQuantity,
        IERC20 _component,
        bool /* isEquity */
    ) external override onlyModule(_setToken) {
        int256 externalPositionUnit = _setToken.getExternalPositionRealUnit(address(_component), address(this));
        uint256 usdcToWithdraw = _setTokenQuantity.preciseMul(externalPositionUnit.toUint256());

        _setToken.invokeWithdraw(perpVault, _setToken, usdcToWithdraw);
    }

    /* ============ External Getter Functions ============ */

    function getPositionInfo(ISetToken _setToken) public view returns (PositionInfo[] memory) {
        PositionInfo[] memory positionInfo = new PositionInfo[](positions[_setToken].length);

        for(uint i = 0; i < positions[_setToken].length; i++){
            positionInfo[i] = PositionInfo({
                baseToken: positions[_setToken][i].baseToken,
                baseBalance: perpAccountBalance.getBase(
                    address(_setToken),
                    address(positions[_setToken][i].baseToken)
                ),
                quoteBalance: perpAccountBalance.getQuote(
                    address(_setToken),
                    address(positions[_setToken][i].baseToken)
                )
            });
        }

        return positionInfo;
    }

    function getAccountInfo(ISetToken _setToken) public view returns (AccountInfo memory accountInfo) {
        (int256 owedRealizedPnL, ) = perpAccountBalance.getOwedAndUnrealizedPnl(address(_setToken));

        accountInfo = AccountInfo({
            collateralBalance: _getCollateralBalance(_setToken),
            owedRealizedPnL: owedRealizedPnL,
            pendingFundingPayments: perpExchange.getAllPendingFundingPayment(address(_setToken)),

            // TODO: think this is also in "settlement decimals"
            accountValue: perpClearingHouse.getAccountValue(address(_setToken)),
            marginRequirement: perpAccountBalance.getMarginRequirementForLiquidation(address(_setToken))

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

    function _executeTrade(ActionInfo memory _actionInfo) internal returns (uint256, uint256) {
        IClearingHouse.OpenPositionParams memory params = IClearingHouse.OpenPositionParams({
            baseToken: address(_actionInfo.baseToken),
            isBaseToQuote: _actionInfo.isBaseToQuote,
            isExactInput: _actionInfo.isExactInput,
            amount: _actionInfo.amount.toUint256(),
            oppositeAmountBound: _actionInfo.oppositeAmountBound,
            deadline: 0,
            sqrtPriceLimitX96: 0,
            referralCode: 0
        });

        return _actionInfo.setToken.invokeOpenPosition(perpClearingHouse, params);
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

        withdraw(_setToken, protocolFeeUnits);
        payProtocolFeeFromSetToken(_setToken, address(token), protocolFee);
        return protocolFee;
    }

    function _createAndValidateActionInfo(
        ISetToken _setToken,
        IERC20 _baseToken,
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
        IERC20 _baseToken,
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
                address(_baseToken)
            )
        });

        _validateCommon(actionInfo);

        return actionInfo;
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
        IERC20 token = collateralToken[_setToken];
        uint8 decimals = ERC20(address(token)).decimals();
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
        return amount.preciseDiv(10**(18 - uint(decimals)));
    }

    function _parseCollateralToken(int256 amount, uint8 decimals) internal pure returns (int256) {
        return amount.preciseMul(int256(10**(18 - uint(decimals))));
    }

    function _abs(int x) internal pure returns (int) {
        return x >= 0 ? x : -x;
    }
}