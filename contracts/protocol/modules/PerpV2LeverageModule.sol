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

import "@openzeppelin/contracts/math/SignedSafeMath.sol";
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
import { IMarketRegistry } from "../../interfaces/external/perp-v2/IMarketRegistry.sol";
import { IController } from "../../interfaces/IController.sol";
import { IDebtIssuanceModule } from "../../interfaces/IDebtIssuanceModule.sol";
import { IModuleIssuanceHook } from "../../interfaces/IModuleIssuanceHook.sol";
import { ISetToken } from "../../interfaces/ISetToken.sol";
import { ModuleBase } from "../lib/ModuleBase.sol";
import { PreciseUnitMath } from "../../lib/PreciseUnitMath.sol";
import { AddressArrayUtils } from "../../lib/AddressArrayUtils.sol";


/**
 * @title PerpLeverageModule
 * @author Set Protocol
 * @notice Smart contract that enables leveraged trading using the PerpV2 protocol. Each SetToken can only manage a single Perp account
 * represented as a positive equity external position whose value is the net Perp account value denominated in the collateral token
 * deposited into the Perp Protocol. This module only allows Perp positions to be collateralized by one asset, USDC, set on deployment of
 * this contract (see collateralToken) however it can take positions simultaneuosly in multiple base assets.
 *
 * Upon issuance and redemption positions are not EXACTLY replicated like for other position types since a trade is necessary to enter/exit
 * the position on behalf of the issuer/redeemer. Any cost of entering/exiting the position (slippage) is carried by the issuer/redeemer.
 * Any pending funding costs or PnL is carried by the current token holders. To be used safely this module MUST issue using the
 * SlippageIssuanceModule or else issue and redeem transaction could be sandwich attacked.
 *
 * NOTE: The external position unit is only updated on an as-needed basis during issuance/redemption. It does not reflect the current
 * value of the Set's perpetual position. The current value can be calculated from getPositionNotionalInfo.
 */
contract PerpV2LeverageModule is ModuleBase, ReentrancyGuard, Ownable, IModuleIssuanceHook {
    using PerpV2 for ISetToken;
    using PreciseUnitMath for int256;
    using SignedSafeMath for int256;
    using AddressArrayUtils for address[];

    /* ============ Structs ============ */

    struct ActionInfo {
        ISetToken setToken;
        address baseToken;              // Virtual token minted by the Perp protocol
        bool isBaseToQuote;             // When true, `baseToken` is being sold, when false, bought
        bool isExactInput;              // When true, `amount` is the swap input, when false, the swap output
        int256 amount;                  // Quantity in 10**18 decimals
        uint256 oppositeAmountBound;    // vUSDC pay or receive quantity bound (see `_createAndValidateActionInfoNotionalNotional` for details)
    }

    struct PositionNotionalInfo {
        address baseToken;              // Virtual token minted by the Perp protocol
        int256 baseBalance;             // Base position notional quantity in 10**18 decimals. When negative, position is short
        int256 quoteBalance;            // vUSDC "debt" notional quantity minted to open position. When positive, position is short
    }

    struct PositionUnitInfo {
        address baseToken;              // Virtual token minted by the Perp protocol
        int256 baseUnit;                // Base position unit. When negative, position is short
        int256 quoteUnit;               // vUSDC "debt" position unit. When positive, position is short
    }

    struct AccountInfo {
        int256 collateralBalance;       // Quantity of collateral deposited in Perp vault in 10**18 decimals
        int256 owedRealizedPnl;         // USDC quantity of profit and loss in 10**18 decimals not yet settled to vault
        int256 pendingFundingPayments;  // USDC quantity of pending funding payments in 10**18 decimals
        int256 netQuoteBalance;         // USDC quantity of net quote balance for all open positions in Perp account
    }

    /* ============ Events ============ */

    /**
     * @dev Emitted on trade
     * @param _setToken         Instance of SetToken
     * @param _baseToken        Virtual token minted by the Perp protocol
     * @param _deltaBase        Change in baseToken position size resulting from trade
     * @param _deltaQuote       Change in vUSDC position size resulting from trade
     * @param _protocolFee      Quantity in collateral decimals sent to fee recipient during lever trade
     * @param _isBuy            True when baseToken is being bought, false when being sold
     */
    event PerpTrade(
        ISetToken indexed _setToken,
        address indexed _baseToken,
        uint256 _deltaBase,
        uint256 _deltaQuote,
        uint256 _protocolFee,
        bool _isBuy
    );

    /**
     * @dev Emitted on deposit (not issue or redeeem)
     * @param _setToken             Instance of SetToken
     * @param _collateralToken      Token being deposited as collateral (USDC)
     * @param _amountDeposited      Amount of collateral being deposited into Perp
     */
    event CollateralDeposited(
        ISetToken indexed _setToken,
        IERC20 _collateralToken,
        uint256 _amountDeposited
    );

    /**
     * @dev Emitted on withdraw (not issue or redeeem)
     * @param _setToken             Instance of SetToken
     * @param _collateralToken      Token being withdrawn as collateral (USDC)
     * @param _amountWithdrawn      Amount of collateral being withdrawn from Perp
     */
    event CollateralWithdrawn(
        ISetToken indexed _setToken,
        IERC20 _collateralToken,
        uint256 _amountWithdrawn
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

    // PerpV2 contract which provides getters for base, quote, and owedRealizedPnl balances
    IAccountBalance public immutable perpAccountBalance;

    // PerpV2 contract which provides a trading API
    IClearingHouse public immutable perpClearingHouse;

    // PerpV2 contract which manages trading logic. Provides getters for UniswapV3 pools and pending funding balances
    IExchange public immutable perpExchange;

    // PerpV2 contract which handles deposits and withdrawals. Provides getter for collateral balances
    IVault public immutable perpVault;

    // PerpV2 contract which makes it possible to simulate a trade before it occurs
    IQuoter public immutable perpQuoter;

    // PerpV2 contract which provides a getter for baseToken UniswapV3 pools
    IMarketRegistry public immutable perpMarketRegistry;

    // Token (USDC) used as a vault deposit, Perp currently only supports USDC as it's setllement and collateral token
    IERC20 public immutable collateralToken;

    // Decimals of collateral token. We set this in the constructor for later reading
    uint8 public immutable collateralDecimals;

    // Mapping of SetTokens to an array of virtual token addresses the Set has open positions for.
    // Array is automatically updated when new positions are opened or old positions are zeroed out.
    mapping(ISetToken => address[]) public positions;

    // Mapping of SetToken to boolean indicating if SetToken is on allow list. Updateable by governance
    mapping(ISetToken => bool) public allowedSetTokens;

    // Boolean that returns if any SetToken can initialize this module. If false, then subject to allow list.
    // Updateable by governance.
    bool public anySetAllowed;


    /* ============ Constructor ============ */

    /**
     * @dev Sets external PerpV2 Protocol addresses.
     * @param _controller               Address of controller contract
     * @param _perpVault                Address of Perp Vault contract
     * @param _perpQuoter               Address of Perp Quoter contract
     * @param _perpMarketRegistry       Address of Perp MarketRegistry contract
     */
    constructor(
        IController _controller,
        IVault _perpVault,
        IQuoter _perpQuoter,
        IMarketRegistry _perpMarketRegistry
    )
        public
        ModuleBase(_controller)
    {
        // Use temp variables to initialize immutables
        address tempCollateralToken = IVault(_perpVault).getSettlementToken();
        collateralToken = IERC20(tempCollateralToken);
        collateralDecimals = ERC20(tempCollateralToken).decimals();

        perpAccountBalance = IAccountBalance(IVault(_perpVault).getAccountBalance());
        perpClearingHouse = IClearingHouse(IVault(_perpVault).getClearingHouse());
        perpExchange = IExchange(IVault(_perpVault).getExchange());
        perpVault = _perpVault;
        perpQuoter = _perpQuoter;
        perpMarketRegistry = _perpMarketRegistry;
    }

    /* ============ External Functions ============ */

    /**
     * @dev MANAGER ONLY: Allows manager to buy or sell perps to change exposure to the underlying baseToken.
     * Providing a positive value for `_baseQuantityUnits` buys vToken on UniswapV3 via Perp's ClearingHouse,
     * Providing a negative value sells the token. `_receiveQuoteQuantityUnits` defines a min-receive-like slippage
     * bound for the amount of vUSDC quote asset the trade will either pay or receive as a result of the action.
     *
     * NOTE: This method doesn't update the externalPositionUnit because it is a function of UniswapV3 virtual
     * token market prices and needs to be generated on the fly to be meaningful.
     *
     * As a user when levering, e.g increasing the magnitude of your position, you'd trade as below
     * | ----------------------------------------------------------------------------------------------- |
     * | Type  |  Action | Goal                      | `receiveQuoteQuantity`      | `baseQuantityUnits` |
     * | ----- |-------- | ------------------------- | --------------------------- | ------------------- |
     * | Long  | Buy     | pay least amt. of vQuote  | upper bound of input quote  | positive            |
     * | Short | Sell    | get most amt. of vQuote   | lower bound of output quote | negative            |
     * | ----------------------------------------------------------------------------------------------- |
     *
     * As a user when delevering, e.g decreasing the magnitude of your position, you'd trade as below
     * | ----------------------------------------------------------------------------------------------- |
     * | Type  |  Action | Goal                      | `receiveQuoteQuantity`      | `baseQuantityUnits` |
     * | ----- |-------- | ------------------------- | --------------------------- | ------------------- |
     * | Long  | Sell    | get most amt. of vQuote   | upper bound of input quote  | negative            |
     * | Short | Buy     | pay least amt. of vQuote  | lower bound of output quote | positive            |
     * | ----------------------------------------------------------------------------------------------- |
     *
     * @param _setToken                     Instance of the SetToken
     * @param _baseToken                    Address virtual token being traded
     * @param _baseQuantityUnits            Quantity of virtual token to trade in position units
     * @param _receiveQuoteQuantityUnits    Max/min of vQuote asset to pay/receive when buying or selling
     */
    function trade(
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

        uint256 protocolFee = _accrueProtocolFee(_setToken, deltaQuote);

        _updatePositionList(_setToken, _baseToken);

        emit PerpTrade(
            _setToken,
            _baseToken,
            deltaBase,
            deltaQuote,
            protocolFee,
            _baseQuantityUnits > 0
        );
    }

    /**
     * @dev MANAGER ONLY: Deposits default position collateral token into the PerpV2 Vault, increasing
     * the size of the Perp account external position. This method is useful for establishing initial
     * collateralization ratios, e.g the flow when setting up a 2X external position would be to deposit
     * 100 units of USDC and execute a lever trade for ~200 vUSDC worth of vToken with the difference
     * between these made up as automatically "issued" margin debt in the PerpV2 system.
     *
     * @param  _setToken                    Instance of the SetToken
     * @param  _collateralQuantityUnits     Quantity of collateral to deposit in position units
     */
    function deposit(
      ISetToken _setToken,
      uint256 _collateralQuantityUnits
    )
      public
      nonReentrant
      onlyManagerAndValidSet(_setToken)
    {
        require(_collateralQuantityUnits > 0, "Deposit amount is 0");
        require(_setToken.totalSupply() > 0, "SetToken supply is 0");

        uint256 notionalDepositedQuantity = _depositAndUpdatePositions(_setToken, _collateralQuantityUnits);

        emit CollateralDeposited(_setToken, collateralToken, notionalDepositedQuantity);
    }

    /**
     * @dev MANAGER ONLY: Withdraws collateral token from the PerpV2 Vault to a default position on
     * the SetToken. This method is useful when adjusting the overall composition of a Set which has
     * a Perp account external position as one of several components.
     *
     * NOTE: Within PerpV2, `withdraw` settles `owedRealizedPnl` and any pending funding payments
     * to the Perp vault prior to transfer.
     *
     * @param  _setToken                    Instance of the SetToken
     * @param  _collateralQuantityUnits     Quantity of collateral to withdraw in position units
     */
    function withdraw(
      ISetToken _setToken,
      uint256 _collateralQuantityUnits
    )
      public
      nonReentrant
      onlyManagerAndValidSet(_setToken)
    {
        require(_collateralQuantityUnits > 0, "Withdraw amount is 0");
        require(_setToken.totalSupply() > 0, "SetToken supply is 0");

        uint256 notionalWithdrawnQuantity = _withdrawAndUpdatePositions(_setToken, _collateralQuantityUnits);

        emit CollateralWithdrawn(_setToken, collateralToken, notionalWithdrawnQuantity);
    }

    /**
     * @dev MANAGER ONLY: Initializes this module to the SetToken. Either the SetToken needs to be on the
     * allowed list or anySetAllowed needs to be true.
     *
     * @param _setToken             Instance of the SetToken to initialize
     */
    function initialize(
        ISetToken _setToken
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
    }

    /**
     * @dev MANAGER ONLY: Removes this module from the SetToken, via call by the SetToken. Deletes
     * position mappings associated with SetToken.
     *
     * NOTE: Function will revert if there is greater than a position unit amount of USDC left in the PerpV2 vault.
     */
    function removeModule() external override onlyValidAndInitializedSet(ISetToken(msg.sender)) {
        ISetToken setToken = ISetToken(msg.sender);

        // We can end up with a dust amount of USDC in the Perp account that we should ignore.
        require(
            _fromPreciseUnitToDecimals(_getCollateralBalance(setToken), collateralDecimals) <= 1,
            "Collateral balance remaining"
        );

        delete positions[setToken]; // Should already be empty

        // Try if unregister exists on any of the modules
        address[] memory modules = setToken.getModules();
        for(uint256 i = 0; i < modules.length; i++) {
            try IDebtIssuanceModule(modules[i]).unregisterFromIssuanceModule(setToken) {} catch {}
        }
    }

    /**
     * @dev MANAGER ONLY: Add registration of this module on the debt issuance module for the SetToken.
     *
     * Note: if the debt issuance module is not added to SetToken before this module is initialized, then
     * this function needs to be called if the debt issuance module is later added and initialized to prevent state
     * inconsistencies
     *
     * @param _setToken             Instance of the SetToken
     * @param _debtIssuanceModule   Debt issuance module address to register
     */
    function registerToModule(ISetToken _setToken, IDebtIssuanceModule _debtIssuanceModule) external onlyManagerAndValidSet(_setToken) {
        require(_setToken.isInitializedModule(address(_debtIssuanceModule)), "Issuance not initialized");

        _debtIssuanceModule.registerToIssuanceModule(_setToken);
    }

    /**
     * @dev GOVERNANCE ONLY: Enable/disable ability of a SetToken to initialize this module.
     *
     * @param _setToken             Instance of the SetToken
     * @param _status               Bool indicating if _setToken is allowed to initialize this module
     */
    function updateAllowedSetToken(ISetToken _setToken, bool _status) external onlyOwner {
        require(controller.isSet(address(_setToken)) || allowedSetTokens[_setToken], "Invalid SetToken");
        allowedSetTokens[_setToken] = _status;
        emit SetTokenStatusUpdated(_setToken, _status);
    }

    /**
     * @dev GOVERNANCE ONLY: Toggle whether ANY SetToken is allowed to initialize this module.
     *
     * @param _anySetAllowed             Bool indicating if ANY SetToken is allowed to initialize this module
     */
    function updateAnySetAllowed(bool _anySetAllowed) external onlyOwner {
        anySetAllowed = _anySetAllowed;
        emit AnySetAllowedUpdated(_anySetAllowed);
    }

    /**
     * @dev MODULE ONLY: Hook called prior to issuance. Only callable by valid module. Should only be called ONCE
     * during issue. Trades into current positions and sets the collateralToken's externalPositionUnit so that
     * issuance module can transfer in the right amount of collateral accounting for accrued fees/pnl and slippage
     * incurred during issuance. Any pending funding payments and accrued owedRealizedPnl are attributed to current
     * Set holders.
     *
     * @param _setToken             Instance of the SetToken
     * @param _setTokenQuantity     Quantity of Set to issue
     */
    function moduleIssueHook(
        ISetToken _setToken,
        uint256 _setTokenQuantity
    )
        external
        override
        onlyModule(_setToken)
    {
        if (_setToken.totalSupply() == 0) return;

        int256 newExternalPositionUnit = _executeModuleIssuanceHook(_setToken, _setTokenQuantity, false);

        // Set collateralToken externalPositionUnit such that DIM can use it for transfer calculation
        _setToken.editExternalPositionUnit(
            address(collateralToken),
            address(this),
            newExternalPositionUnit
        );
    }

    /**
     * @dev MODULE ONLY: Hook called prior to redemption in the issuance module. Trades out of existing
     * positions to make redemption capital withdrawable from PerpV2 vault. Sets the `externalPositionUnit`
     * equal to the realizable value of account in position units (as measured by the trade outcomes for
     * this redemption). Any `owedRealizedPnl` and pending funding payments are socialized in this step so
     * that redeemer pays/receives their share of them. Should only be called ONCE during redeem.
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

        int256 newExternalPositionUnit = _executeModuleRedemptionHook(_setToken, _setTokenQuantity, false);

        // Set USDC externalPositionUnit such that DIM can use it for transfer calculation
        _setToken.editExternalPositionUnit(
            address(collateralToken),
            address(this),
            newExternalPositionUnit
        );
    }

    /**
     * @dev MODULE ONLY: Hook called prior to looping through each component on issuance. Deposits
     * collateral into Perp protocol from SetToken default position.
     * @param _setToken             Instance of the SetToken
     * @param _setTokenQuantity     Quantity of SetToken to issue
     * @param _component            Address of deposit collateral component
     */
    function componentIssueHook(
        ISetToken _setToken,
        uint256 _setTokenQuantity,
        IERC20 _component,
        bool _isEquity
    )
        external
        override
        onlyModule(_setToken)
    {
        if (_isEquity) {
            int256 externalPositionUnit = _setToken.getExternalPositionRealUnit(address(_component), address(this));

            // Use preciseMulCeil here to ensure correct collateralization if there are rounding errors.
            uint256 usdcTransferInNotionalQuantity = _setTokenQuantity.preciseMulCeil(externalPositionUnit.toUint256());

            _deposit(_setToken, usdcTransferInNotionalQuantity);
        }
    }

    /**
     * @dev MODULE ONLY: Hook called prior to looping through each component on redemption. Withdraws
     * collateral from Perp protocol to SetToken default position *without* updating the default position unit.
     * Called by issuance module's `resolveEquityPositions` method which immediately transfers the collateral
     * component from SetToken to redeemer after this hook executes.
     *
     * @param _setToken             Instance of the SetToken
     * @param _setTokenQuantity     Quantity of SetToken to redeem
     * @param _component            Address of deposit collateral component
     */
    function componentRedeemHook(
        ISetToken _setToken,
        uint256 _setTokenQuantity,
        IERC20 _component,
        bool _isEquity
    )
        external
        override
        onlyModule(_setToken)
    {
        if (_isEquity) {
            int256 externalPositionUnit = _setToken.getExternalPositionRealUnit(address(_component), address(this));
            uint256 usdcTransferOutNotionalQuantity = _setTokenQuantity.preciseMul(externalPositionUnit.toUint256());

            _withdraw(_setToken, usdcTransferOutNotionalQuantity);
        }
    }

    /* ============ External Getter Functions ============ */

    /**
     * @dev Gets the positive equity collateral externalPositionUnit that would be calculated for
     * issuing a quantity of SetToken, representing the amount of collateral that would need to
     * be transferred in per SetToken.
     *
     * @param _setToken             Instance of SetToken
     * @param _setTokenQuantity     Number of sets to issue
     *
     * @return equityAdjustments array containing a single element and an empty debtAdjustments array
     */
    function getIssuanceAdjustments(
        ISetToken _setToken,
        uint256 _setTokenQuantity
    )
        external
        returns (int256[] memory, int256[] memory)
    {
        address[] memory components = _setToken.getComponents();

        if (positions[_setToken].length > 0) {
            int256 newExternalPositionUnit = _executeModuleIssuanceHook(_setToken, _setTokenQuantity, true);
            return _formatAdjustments(_setToken, components, newExternalPositionUnit);
        } else {
            return _formatAdjustments(_setToken, components, 0);
        }
    }

    /**
     * @dev Gets the positive equity collateral externalPositionUnit that would be calculated for
     * redeeming a quantity of SetToken representing the amount of collateral returned per SetToken.
     *
     * @param _setToken             Instance of SetToken
     * @param _setTokenQuantity     Number of sets to issue
     *
     * @return equityAdjustments array containing a single element and an empty debtAdjustments array
     */
    function getRedemptionAdjustments(
        ISetToken _setToken,
        uint256 _setTokenQuantity
    )
        external
        returns (int256[] memory, int256[] memory _)
    {
        address[] memory components = _setToken.getComponents();

        if (positions[_setToken].length > 0) {
            int256 newExternalPositionUnit = _executeModuleRedemptionHook(_setToken, _setTokenQuantity, true);
            return _formatAdjustments(_setToken, components, newExternalPositionUnit);
        } else {
            return _formatAdjustments(_setToken, components, 0);
        }
    }

    /**
     * @dev Returns a PositionUnitNotionalInfo array representing all positions open for the SetToken.
     *
     * @param _setToken         Instance of SetToken
     *
     * @return PositionUnitInfo array, in which each element has properties:
     *
     *         + baseToken: address,
     *         + baseBalance:  baseToken balance as notional quantity (10**18)
     *         + quoteBalance: USDC quote asset balance as notional quantity (10**18)
     */
    function getPositionNotionalInfo(ISetToken _setToken) public view returns (PositionNotionalInfo[] memory) {
        PositionNotionalInfo[] memory positionInfo = new PositionNotionalInfo[](positions[_setToken].length);

        for(uint i = 0; i < positions[_setToken].length; i++){
            positionInfo[i] = PositionNotionalInfo({
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

    /**
     * @dev Returns a PositionUnitInfo array representing all positions open for the SetToken.
     *
     * @param _setToken         Instance of SetToken
     *
     * @return PositionUnitInfo array, in which each element has properties:
     *
     *         + baseToken: address,
     *         + baseUnit:  baseToken balance as position unit (10**18)
     *         + quoteUnit: USDC quote asset balance as position unit (10**18)
     */
    function getPositionUnitInfo(ISetToken _setToken) public view returns (PositionUnitInfo[] memory) {
        int256 totalSupply = _setToken.totalSupply().toInt256();
        PositionUnitInfo[] memory positionInfo = new PositionUnitInfo[](positions[_setToken].length);

        for(uint i = 0; i < positions[_setToken].length; i++){
            positionInfo[i] = PositionUnitInfo({
                baseToken: positions[_setToken][i],
                baseUnit: perpAccountBalance.getBase(
                    address(_setToken),
                    positions[_setToken][i]
                ).preciseDiv(totalSupply),
                quoteUnit: perpAccountBalance.getQuote(
                    address(_setToken),
                    positions[_setToken][i]
                ).preciseDiv(totalSupply)
            });
        }

        return positionInfo;
    }


    /**
     * @dev Gets Perp account info for SetToken. Returns an AccountInfo struct containing account wide
     * (rather than position specific) balance info
     *
     * @param  _setToken            Instance of the SetToken
     *
     * @return accountInfo          struct with properties for:
     *
     *         + collateral balance (10**18, regardless of underlying collateral decimals)
     *         + owed realized Pnl` (10**18)
     *         + pending funding payments (10**18)
     */
    function getAccountInfo(ISetToken _setToken) public view returns (AccountInfo memory accountInfo) {
        (int256 owedRealizedPnl,, ) =  perpAccountBalance.getPnlAndPendingFee(address(_setToken));
        (int256 netQuoteBalance, ) =  perpAccountBalance.getNetQuoteBalanceAndPendingFee(address(_setToken));

        // NOTE: pendingFundingPayments are represented as in the Perp system as "funding owed"
        // e.g a positive number is a debt which gets subtracted from owedRealizedPnl on settlement.
        // We are flipping its sign here to reflect its settlement value.
        accountInfo = AccountInfo({
            collateralBalance: _getCollateralBalance(_setToken),
            owedRealizedPnl: owedRealizedPnl,
            pendingFundingPayments: perpExchange.getAllPendingFundingPayment(address(_setToken)).mul(-1),
            netQuoteBalance: netQuoteBalance
        });
    }

    /**
     * @dev Gets the mid-point price of a virtual asset from UniswapV3 markets maintained by Perp Protocol
     *
     * @param  _baseToken)          Address of virtual token to price
     * @return price                Mid-point price of virtual token in UniswapV3 AMM market
     */
    function getAMMSpotPrice(address _baseToken) public view returns (uint256 price) {
        address pool = perpMarketRegistry.getPool(_baseToken);
        (uint160 sqrtPriceX96, , , , , , ) = IUniswapV3Pool(pool).slot0();
        uint256 priceX96 = _formatSqrtPriceX96ToPriceX96(sqrtPriceX96);
        return _formatX96ToX10_18(priceX96);
    }

    /* ============ Internal Functions ============ */

    /**
     * @dev MODULE ONLY: Hook called prior to issuance. Only callable by valid module.
     *
     * NOTE: OwedRealizedPnl and PendingFunding values can be either positive or negative
     *
     * OwedRealizedPnl
     * ---------------
     * Accrues when trades execute and result in a profit or loss per the table
     * below. Each withdrawal zeros out `owedRealizedPnl`, settling it to the vault.
     *
     * | -------------------------------------------------- |
     * | Position Type | AMM Spot Price | Action | Value    |
     * | ------------- | -------------- | ------ | -------  |
     * | Long          | Rises          | Sell   | Positive |
     * | Long          | Falls          | Sell   | Negative |
     * | Short         | Rises          | Buy    | Negative |
     * | Short         | Falls          | Buy    | Positive |
     * | -------------------------------------------------- |
     *
     *
     * PendingFunding
     * --------------
     * The direction of this flow is determined by the difference between virtual asset UniV3 spot prices and
     * their parent asset's broader market price (as represented by a Chainlink oracle), per the table below.
     * Each trade zeroes out `pendingFunding`, settling it to owedRealizedPnl.
     *
     * | --------------------------------------- |
     * | Position Type | Oracle Price | Value    |
     * | ------------- | ------------ | -------- |
     * | Long          | Below AMM    | Negative |
     * | Long          | Above AMM    | Positive |
     * | Short         | Below AMM    | Positive |
     * | Short         | Above AMM    | Negative |
     * | --------------------------------------- |
     *
     * @param _setToken             Instance of the SetToken
     * @param _setTokenQuantity     Quantity of Set to issue
     * @param _isSimulation         If true, trading is only simulated (to return issuance adjustments)
     */
    function _executeModuleIssuanceHook(
        ISetToken _setToken,
        uint256 _setTokenQuantity,
        bool _isSimulation
    )
        internal
        returns (int256)
    {
        // From perp:
        // accountValue = collateral                                <---
        //              + owedRealizedPnl                               }   totalCollateralValue
        //              + pendingFundingPayment                     <---
        //              + sum_over_market(positionValue_market)
        //              + netQuoteBalance

        AccountInfo memory accountInfo = getAccountInfo(_setToken);

        int256 usdcAmountIn = accountInfo.collateralBalance
            .add(accountInfo.owedRealizedPnl)
            .add(accountInfo.pendingFundingPayments)
            .add(accountInfo.netQuoteBalance)
            .preciseDiv(_setToken.totalSupply().toInt256())
            .preciseMul(_setTokenQuantity.toInt256());

        PositionUnitInfo[] memory positionInfo = getPositionUnitInfo(_setToken);

        for(uint i = 0; i < positionInfo.length; i++) {
            // baseUnit, +ve existing long position, -ve for existing short position
            int256 baseTradeNotionalQuantity = positionInfo[i].baseUnit.preciseMul(_setTokenQuantity.toInt256());

            ActionInfo memory actionInfo = _createAndValidateActionInfoNotional(
                _setToken,
                positionInfo[i].baseToken,
                baseTradeNotionalQuantity,
                0
            );

            int256 spotPrice = getAMMSpotPrice(positionInfo[i].baseToken).toInt256();

            // idealDeltaQuote, +ve for existing long position, -ve for existing short position
            int256 idealDeltaQuote = baseTradeNotionalQuantity.preciseMul(spotPrice);

            // Execute or simulate trade.
            // `deltaQuote` is always a positive number
            (, uint256 deltaQuote) = _isSimulation ? _simulateTrade(actionInfo) : _executeTrade(actionInfo);

            // Calculate slippage quantity as a positive value
            // When long, trade slippage results in more quote required, deltaQuote > idealDeltaQuote
            // When short, trade slippage results in less quote receivied, abs(idealDeltaQuote) > abs(deltaQuote)
            int256 slippageQuantity = baseTradeNotionalQuantity >= 0
                ? deltaQuote.toInt256().sub(idealDeltaQuote)
                : _abs(idealDeltaQuote).sub(deltaQuote.toInt256());

            // slippage is borne by the issuer
            usdcAmountIn = usdcAmountIn.add(idealDeltaQuote).add(slippageQuantity);
        }

        // Return value in collateral decimals (e.g USDC = 6)
        return _fromPreciseUnitToDecimals(
            usdcAmountIn.preciseDiv(_setTokenQuantity.toInt256()),
            collateralDecimals
        );
    }

    /**
     * @dev Hook called prior to redemption. Only callable by valid module.
     * @param _setToken             Instance of the SetToken
     * @param _setTokenQuantity     Quantity of Set to redeem
     * @param _isSimulation         If true, trading is only simulated (to return issuance adjustments)
     */
    function _executeModuleRedemptionHook(
        ISetToken _setToken,
        uint256 _setTokenQuantity,
        bool _isSimulation
    )
        internal
        returns (int256)
    {
        int256 realizedPnl = 0;

        PositionNotionalInfo[] memory positionInfo = getPositionNotionalInfo(_setToken);
        AccountInfo memory accountInfo = getAccountInfo(_setToken);

        // Calculate already accrued PnL from non-issuance/redemption sources (ex: levering)
        int256 totalFundingAndCarriedPnL = accountInfo.pendingFundingPayments.add(accountInfo.owedRealizedPnl);
        int256 owedRealizedPnlPositionUnit = totalFundingAndCarriedPnL.preciseDiv(_setToken.totalSupply().toInt256());

        for (uint256 i = 0; i < positionInfo.length; i++) {
            // Calculate amount to trade
            int256 basePositionUnit = positionInfo[i].baseBalance.preciseDiv(_setToken.totalSupply().toInt256());
            int256 baseTradeNotionalQuantity = basePositionUnit.preciseMul(_setTokenQuantity.toInt256());

            // Calculate amount quote debt will be reduced by
            int256 reducedOpenNotional = _getReducedOpenNotional(
                _setTokenQuantity.toInt256(),
                basePositionUnit,
                positionInfo[i]
            );

            // Trade, inverting notional quantity sign because we are reducing position
            ActionInfo memory actionInfo = _createAndValidateActionInfoNotional(
                _setToken,
                positionInfo[i].baseToken,
                baseTradeNotionalQuantity.mul(-1),
                0
            );

            // Execute or simulate trade.
            // `deltaQuote` is always a positive number
            (,uint256 deltaQuote) = _isSimulation ? _simulateTrade(actionInfo) : _executeTrade(actionInfo);

            // Calculate realized PnL for and add to running total.
            // When basePositionUnit is positive, position is long.
            realizedPnl = basePositionUnit >= 0 ? realizedPnl.add(reducedOpenNotional.add(deltaQuote.toInt256())) :
                realizedPnl.add(reducedOpenNotional.sub(deltaQuote.toInt256()));
        }

        // Calculate amount of collateral to withdraw
        int256 collateralPositionUnit = _getCollateralBalance(_setToken).preciseDiv(_setToken.totalSupply().toInt256());

        int256 usdcToWithdraw =
            collateralPositionUnit.preciseMul(_setTokenQuantity.toInt256())
                .add(owedRealizedPnlPositionUnit.preciseMul(_setTokenQuantity.toInt256()))
                .add(realizedPnl);

        return _fromPreciseUnitToDecimals(
            usdcToWithdraw.preciseDiv(_setTokenQuantity.toInt256()),
            collateralDecimals
        );
    }

    /**
     * @dev Invoke deposit from SetToken using PerpV2 library. Creates a collateral deposit in Perp vault
     * Updates the collateral token default position unit. This function is called directly by
     * the componentIssue hook, skipping external position unit setting because that method is assumed
     * to be the end of a call sequence (e.g manager will not need to read the updated value)
     */
    function _deposit(ISetToken _setToken, uint256 _collateralNotionalQuantity) internal {
        _setToken.invokeApprove(
            address(collateralToken),
            address(perpVault),
            _collateralNotionalQuantity
        );

        _setToken.invokeDeposit(perpVault, collateralToken, _collateralNotionalQuantity);
    }

    /**
     * Approves and deposits collateral units into Perp vault and additionally sets collateral token externalPositionUnit
     * so Manager contracts have a value they can base calculations for further trading on within the same transaction.
     *
     * NOTE: This flow is only used when invoking the external `deposit` function - it converts collateral
     * quantity units into a notional quantity.
     */
    function _depositAndUpdatePositions(
        ISetToken _setToken,
        uint256 _collateralQuantityUnits
    )
        internal
        returns (uint256)
    {
        uint256 initialCollateralPositionBalance = collateralToken.balanceOf(address(_setToken));
        uint256 collateralNotionalQuantity = _collateralQuantityUnits.preciseMul(_setToken.totalSupply());

        _deposit(_setToken, collateralNotionalQuantity);

        _setToken.calculateAndEditDefaultPosition(
            address(collateralToken),
            _setToken.totalSupply(),
            initialCollateralPositionBalance
        );

        _setToken.editExternalPosition(
            address(collateralToken),
            address(this),
            _calculateExternalPositionUnit(_setToken),
            ""
        );

        return collateralNotionalQuantity;
    }

    /**
     * @dev Invoke withdraw from SetToken using PerpV2 library. Withdraws collateral token from Perp vault
     * into a default position. This function is called directly by _accrueFee and _moduleRedeemHook,
     * skipping position unit state updates because the funds withdrawn to SetToken are immediately
     * forwarded to `feeRecipient` and SetToken owner respectively.
     */
    function _withdraw(ISetToken _setToken, uint256 _collateralNotionalQuantity) internal {
        if (_collateralNotionalQuantity == 0) return;

        _setToken.invokeWithdraw(perpVault, collateralToken, _collateralNotionalQuantity);
    }

    /**
     * Withdraws collateral units from Perp vault to SetToken and additionally sets both the collateralToken
     * externalPositionUnit (so Manager contracts have a value they can base calculations for further
     * trading on within the same transaction), and the collateral token default position unit.
     *
     * NOTE: This flow is only used when invoking the external `withdraw` function - it converts
     * a collateral units quantity into a notional quantity before invoking withdraw.
     */
    function _withdrawAndUpdatePositions(
        ISetToken _setToken,
        uint256 _collateralQuantityUnits

    )
        internal
        returns (uint256)
    {
        uint256 initialCollateralPositionBalance = collateralToken.balanceOf(address(_setToken));
        uint256 collateralNotionalQuantity = _collateralQuantityUnits.preciseMul(_setToken.totalSupply());

        _withdraw(_setToken, collateralNotionalQuantity);

        _setToken.calculateAndEditDefaultPosition(
            address(collateralToken),
            _setToken.totalSupply(),
            initialCollateralPositionBalance
        );

        _setToken.editExternalPosition(
            address(collateralToken),
            address(this),
            _calculateExternalPositionUnit(_setToken),
            ""
        );

        return collateralNotionalQuantity;
    }

    /**
     * @dev Formats Perp Protocol openPosition call and executes via SetToken (and PerpV2 lib)
     * @return uint256     The base position delta resulting from the trade
     * @return uint256     The quote asset position delta resulting from the trade
     */
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


    /**
     * @dev Formats Perp Periphery Quoter.swap call and executes via SetToken (and PerpV2 lib)
     * @return uint256     The base position delta resulting from the trade
     * @return uint256     The quote asset position delta resulting from the trade
     */
    function _simulateTrade(ActionInfo memory _actionInfo) internal returns (uint256, uint256) {
        IQuoter.SwapParams memory params = IQuoter.SwapParams({
            baseToken: _actionInfo.baseToken,
            isBaseToQuote: _actionInfo.isBaseToQuote,
            isExactInput: _actionInfo.isExactInput,
            amount: _actionInfo.amount.toUint256(),
            sqrtPriceLimitX96: 0
        });

        IQuoter.SwapResponse memory swapResponse = _actionInfo.setToken.invokeSwap(perpQuoter, params);
        return (swapResponse.deltaAvailableBase, swapResponse.deltaAvailableQuote);
    }

    /**
     * @dev Calculates protocol fee on module and pays protocol fee from SetToken
     * @return uint256          Total protocol fee paid in underlying collateral decimals e.g (USDC = 6)
     */
    function _accrueProtocolFee(
        ISetToken _setToken,
        uint256 _exchangedQuantity
    )
        internal
        returns(uint256)
    {
        uint256 protocolFee = getModuleFee(PROTOCOL_TRADE_FEE_INDEX, _exchangedQuantity);
        uint256 protocolFeeInCollateralDecimals = _fromPreciseUnitToDecimals(
            protocolFee,
            collateralDecimals
        );

        _withdraw(_setToken, protocolFeeInCollateralDecimals);

        payProtocolFeeFromSetToken(_setToken, address(collateralToken), protocolFeeInCollateralDecimals);

        return protocolFeeInCollateralDecimals;
    }

    /**
     * @dev Construct the ActionInfo struct for trading. This method takes POSITION UNIT amounts and passes to
     *  _createAndValidateActionInfoNotional to create the struct. If the _baseTokenQuantity is zero then revert.
     *
     * @param _setToken             Instance of the SetToken
     * @param _baseToken            Address of base token being traded into/out of
     * @param _baseTokenUnits       Quantity of baseToken to trade in PositionUnits
     * @param _quoteReceiveUnits    Quantity of quote to receive if selling base and pay if buying, in PositionUnits
     *
     * @return ActionInfo           Instance of constructed ActionInfo struct
     */
    function _createAndValidateActionInfo(
        ISetToken _setToken,
        address _baseToken,
        int256 _baseTokenUnits,
        uint256 _quoteReceiveUnits
    )
        internal
        view
        returns(ActionInfo memory)
    {
        require(_baseTokenUnits != 0, "Amount is 0");

        uint256 totalSupply = _setToken.totalSupply();

        return _createAndValidateActionInfoNotional(
            _setToken,
            _baseToken,
            _baseTokenUnits.preciseMul(totalSupply.toInt256()),
            _quoteReceiveUnits.preciseMul(totalSupply)
        );
    }

    /**
     * @dev Construct the ActionInfo struct for trading. This method takes NOTIONAL token amounts and creates
     * the struct. If the _baseTokenQuantity is less than zero then we are selling the baseToken.
     *
     * | ---------------------------------------------------------------------------------------------|
     * | Action  | isShort | isB2Q  | Exact In / Out        | Amount    | Opposit Bound Description   |
     * | ------- |---------|--------|-----------------------|-----------|---------------------------- |
     * | Sell    |  true   | true   | exact input (true)    | baseToken | Min quote to receive        |
     * | Buy     |  false  | false  | exact output (false)  | baseToken | Max quote to pay            |
     * |----------------------------------------------------------------------------------------------|
     *
     * @param _setToken                 Instance of the SetToken
     * @param _baseToken                Address of base token being traded into/out of
     * @param _baseTokenQuantity        Notional quantity of baseToken to trade
     * @param _quoteReceiveQuantity     Notional quantity of quote to receive if selling base and pay if buying
     *
     * @return ActionInfo               Instance of constructed ActionInfo struct
     */
    function _createAndValidateActionInfoNotional(
        ISetToken _setToken,
        address _baseToken,
        int256 _baseTokenQuantity,
        uint256 _quoteReceiveQuantity
    )
        internal
        pure
        returns(ActionInfo memory)
    {
        // NOT checking that _baseTokenQuantity != 0 here because for places this is directly called
        // (issue/redeem hooks) we know they position cannot be 0. We check in _createAndValidateActionInfo
        // that quantity is 0 for inputs to trade.
        bool isShort = _baseTokenQuantity < 0;

        return ActionInfo({
            setToken: _setToken,
            baseToken: _baseToken,
            isBaseToQuote: isShort,
            isExactInput: isShort,
            amount: _abs(_baseTokenQuantity),
            oppositeAmountBound: _quoteReceiveQuantity
        });
    }

    /**
     * @dev Update position address array if a token has been newly added or completely sold off
     * during lever/delever
     */
    function _updatePositionList(ISetToken _setToken, address _baseToken) internal {
        int256 baseBalance = perpAccountBalance.getBase(address(_setToken), _baseToken);
        address[] memory positionList = positions[_setToken];

        if (positionList.contains(_baseToken) && baseBalance == 0) {
            positions[_setToken].removeStorage(_baseToken);
        }  else if (!positionList.contains(_baseToken)) {
            positions[_setToken].push(_baseToken);
        }
    }

    /**
     * @dev Gets the ratio by which redemption will reduce open notional quote balance. This value
     * is used to calculate realizedPnl of the asset sale in _executeModuleRedeemHook
     */
    function _getReducedOpenNotional(
        int256 _setTokenQuantity,
        int256 _basePositionUnit,
        PositionNotionalInfo memory _positionInfo
    )
        internal
        pure
        returns (int256)
    {
        // From perp formulas: closeRatio = abs(baseTradeNotional) / abs(baseBalance)
        int256 baseTradeNotionalQuantity = _setTokenQuantity.preciseMul(_basePositionUnit);
        int256 closeRatio = _abs(baseTradeNotionalQuantity).preciseDiv(_abs(_positionInfo.baseBalance));
        return _positionInfo.quoteBalance.preciseMul(closeRatio);
    }

    /**
     * @dev Calculates the sum of collateralToken denominated market-prices of assets and debt for the Perp account per
     * SetToken
     */
    function _calculateExternalPositionUnit(ISetToken _setToken) internal view returns (int256) {
        PositionNotionalInfo[] memory positionInfo = getPositionNotionalInfo(_setToken);
        AccountInfo memory accountInfo = getAccountInfo(_setToken);
        int256 totalPositionValue = 0;

        for (uint i = 0; i < positionInfo.length; i++ ) {
            int256 spotPrice = getAMMSpotPrice(positionInfo[i].baseToken).toInt256();
            totalPositionValue = totalPositionValue.add(
                positionInfo[i].baseBalance.preciseMul(spotPrice)
            );
        }

        int256 externalPositionUnitInPrecisionDecimals = totalPositionValue
            .add(accountInfo.collateralBalance)
            .add(accountInfo.netQuoteBalance)
            .add(accountInfo.owedRealizedPnl)
            .add(accountInfo.pendingFundingPayments)
            .preciseDiv(_setToken.totalSupply().toInt256());

        return _fromPreciseUnitToDecimals(
            externalPositionUnitInPrecisionDecimals,
            collateralDecimals
        );
    }

    // @dev Retrieves collateral balance as an an 18 decimal vUSDC quote value
    function _getCollateralBalance(ISetToken _setToken) internal view returns (int256) {
        int256 balance = perpVault.getBalance(address(_setToken));
        return _toPreciseUnitsFromDecimals(balance, collateralDecimals);
    }

    /**
     * @dev Returns issuance or redemption adjustments in the format expected by `SlippageIssuanceModule`.
     * The last recorded externalPositionUnit (current) is subtracted from a dynamically generated
     * externalPositionUnit (new) and set in an `equityAdjustments` array which is the same length as
     * the SetToken's components array, at the same index the collateral token occupies in the components
     * array. All other values are left unset (0). An empty-value components length debtAdjustments
     * array is also returned.
     */
    function _formatAdjustments(
        ISetToken _setToken,
        address[] memory _components,
        int256 _newExternalPositionUnit
    )
        internal
        view
        returns (int256[] memory, int256[] memory)
    {
        int256[] memory equityAdjustments = new int256[](_components.length);
        int256[] memory debtAdjustments = new int256[](_components.length);

        (uint256 index, bool isIn) = _components.indexOf(address(collateralToken));

        if (isIn) {
            int256 currentExternalPositionUnit = _setToken.getExternalPositionRealUnit(
                address(collateralToken),
                address(this)
            );

            equityAdjustments[index] = _newExternalPositionUnit.sub(currentExternalPositionUnit);
        }

        return (equityAdjustments, debtAdjustments);
    }

    /**
     * @dev Converts a UniswapV3 sqrtPriceX96 value to a priceX96 value. This method is borrowed from
     * PerpProtocol's `lushan` repo, in lib/PerpMath and used by `getAMMSpotPrice` while generating a
     * PRECISE_UNIT vAsset market price
     */
    function _formatSqrtPriceX96ToPriceX96(uint160 sqrtPriceX96) internal pure returns (uint256) {
        return FullMath.mulDiv(sqrtPriceX96, sqrtPriceX96, FixedPoint96.Q96);
    }

    /**
     * @dev Converts a UniswapV3 X96 format price into a PRECISE_UNIT price. This method is borrowed from
     * PerpProtocol's `lushan` repo, in lib/PerpMath and used by `getAMMSpotPrice` while generating a
     * PRECISE_UNIT vAsset market price
     */
    function _formatX96ToX10_18(uint256 valueX96) internal pure returns (uint256) {
        return FullMath.mulDiv(valueX96, 1 ether, FixedPoint96.Q96);
    }

    /**
     * @dev Converts a uint256 PRECISE_UNIT quote quantity into an alternative decimal format. In Perp all
     * assets are 18 decimal quantities we need to represent as 6 decimal USDC quantities when setting
     * position units or withdrawing from Perp's Vault contract.
     *
     * This method is borrowed from PerpProtocol's `lushan` repo in lib/SettlementTokenMath
     */
    function _fromPreciseUnitToDecimals(uint256 amount, uint8 decimals) internal pure returns (uint256) {
        return amount.div(10**(18 - uint(decimals)));
    }

    /**
     * @dev Converts an int256 PRECISE_UNIT quote quantity into an alternative decimal format. In Perp all
     * assets are 18 decimal quantities we need to represent as 6 decimal USDC quantities when setting
     * position units or withdrawing from Perp's Vault contract.
     *
     * This method is borrowed from PerpProtocol's `lushan` repo in lib/SettlementTokenMath
     */
    function _fromPreciseUnitToDecimals(int256 amount, uint8 decimals) internal pure returns (int256) {
        return amount.div(int256(10**(18 - uint(decimals))));
    }

    /**
     * @dev Converts an arbitrarily decimalized quantity into a PRECISE_UNIT quantity. In Perp the vault
     * balance is represented as a 6 decimals USDC quantity which we need to consume in PRECISE_UNIT
     * format when calculating values like the external position unit and current leverage.
     */
    function _toPreciseUnitsFromDecimals(int256 amount, uint8 decimals) internal pure returns (int256) {
        return amount.mul(int256(10**(18 - (uint(decimals)))));
    }

    function _abs(int x) internal pure returns (int) {
        return x >= 0 ? x : x.mul(-1);
    }
}