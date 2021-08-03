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
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { AaveV2 } from "../integration/lib/AaveV2.sol";
import { IAToken } from "../../interfaces/external/aave-v2/IAToken.sol";
import { IController } from "../../interfaces/IController.sol";
import { IDebtIssuanceModule } from "../../interfaces/IDebtIssuanceModule.sol";
import { IExchangeAdapter } from "../../interfaces/IExchangeAdapter.sol";
import { ILendingPool } from "../../interfaces/external/aave-v2/ILendingPool.sol";
import { ILendingPoolAddressesProvider } from "../../interfaces/external/aave-v2/ILendingPoolAddressesProvider.sol";
import { IProtocolDataProvider } from "../../interfaces/external/aave-v2/IProtocolDataProvider.sol";
import { ISetToken } from "../../interfaces/ISetToken.sol";
import { IVariableDebtToken } from "../../interfaces/external/aave-v2/IVariableDebtToken.sol";
import { ModuleBase } from "../lib/ModuleBase.sol";

// TODO: Avoid balanceOf() for transferrable tokens
// TODO: Refactor javadoc comments to natspec format

/**
 * @title AaveLeverageModule
 * @author Set Protocol
 *
 * Smart contract that enables leverage trading using Aave as the lending protocol. 
 *
 * Note: Do not use this module in conjunction with other debt modules that allow Aave debt positions as it could lead to double counting of
 * debt when borrowed assets are the same.
 */
contract AaveLeverageModule is ModuleBase, ReentrancyGuard, Ownable {
    using AaveV2 for ISetToken;

    /* ============ Structs ============ */

    struct EnabledAssets {        
        address[] collateralAssets;             // Array of enabled underlying collateral assets for a SetToken
        address[] borrowAssets;                 // Array of enabled underlying borrow assets for a SetToken
    }

    struct ActionInfo {
        ISetToken setToken;                      // SetToken instance
        IExchangeAdapter exchangeAdapter;        // Exchange adapter instance
        uint256 setTotalSupply;                  // Total supply of SetToken
        uint256 notionalSendQuantity;            // Total notional quantity sent to exchange
        uint256 minNotionalReceiveQuantity;      // Min total notional received from exchange
        IERC20 collateralAsset;                  // Address of collateral asset
        IERC20 borrowAsset;                      // Address of borrow asset
        uint256 preTradeReceiveTokenBalance;     // Balance of pre-trade receive token balance
    }

    struct ReserveTokens {
        IAToken aToken;                         // Reserve's aToken instance
        IVariableDebtToken variableDebtToken;   // Reserve's variable debt token instance
    }
    
    /* ============ Events ============ */

    event LeverageIncreased(
        ISetToken indexed _setToken,
        IERC20 indexed _borrowAsset,
        IERC20 indexed _collateralAsset,
        IExchangeAdapter _exchangeAdapter,
        uint256 _totalBorrowAmount,
        uint256 _totalReceiveAmount,
        uint256 _protocolFee
    );

    event LeverageDecreased(
        ISetToken indexed _setToken,
        IERC20 indexed _collateralAsset,
        IERC20 indexed _repayAsset,
        IExchangeAdapter _exchangeAdapter,
        uint256 _totalRedeemAmount,
        uint256 _totalRepayAmount,
        uint256 _protocolFee
    );

    event CollateralAssetsUpdated(
        ISetToken indexed _setToken,
        bool indexed _added,
        IERC20[] _assets
    );

    event BorrowAssetsUpdated(
        ISetToken indexed _setToken,
        bool indexed _added,
        IERC20[] _assets
    );
    
    event AaveReserveUpdated(
        IERC20 indexed _underlying,
        ReserveTokens indexed _reserveTokens
    );
    
    event LendingPoolUpdated(
        ILendingPool indexed _LendingPool
    );

    event SetTokenStatusUpdated(
        ISetToken indexed _setToken,
        bool indexed _added
    );

    event AnySetAllowedUpdated(
        bool indexed _anySetAllowed    
    );

    /* ============ Constants ============ */

    // This module only supports borrowing in variable rate mode from Aave which is represented by 2
    uint256 constant internal BORROW_RATE_MODE = 2;
    
    // String identifying the DebtIssuanceModule in the IntegrationRegistry. Note: Governance must add DefaultIssuanceModule as
    // the string as the integration name
    string constant internal DEFAULT_ISSUANCE_MODULE_NAME = "DefaultIssuanceModule";

    // 0 index stores protocol fee % on the controller, charged in the trade function
    uint256 constant internal PROTOCOL_TRADE_FEE_INDEX = 0;

    /* ============ State Variables ============ */

    // Mapping to efficiently fetch reserve token addresses. Tracking Aave reserve token addresses and updating them 
    // upon requirement is more efficient than fetching them each time from Aave
    mapping(IERC20 => ReserveTokens) public underlyingToReserveTokens;

    // AaveV2 LendingPool contract exposes all user-oriented actions such as deposit, borrow, withdraw and repay
    // We use this variable along with AaveV2 library contract to invoke those actions on SetToken
    // Note: LendingPool contract is mutable and can be updated. Call `updateLendingPool()` to sync lendingPool with Aave.
    ILendingPool public lendingPool;
    
    // Used to fetch reserves and user data from AaveV2
    IProtocolDataProvider public protocolDataProvider;
    
    // Used to fetch lendingPool address
    ILendingPoolAddressesProvider public lendingPoolAddressesProvider;
    
    // Mapping to efficiently check if collateral asset is enabled in SetToken
    mapping(ISetToken => mapping(IERC20 => bool)) public collateralAssetEnabled;
    
    // Mapping to efficiently check if a borrow asset is enabled in SetToken
    mapping(ISetToken => mapping(IERC20 => bool)) public borrowAssetEnabled;
    
    // Internal mapping of enabled collateral and borrow tokens for syncing positions
    mapping(ISetToken => EnabledAssets) internal enabledAssets;

    // Mapping of SetToken to boolean indicating if SetToken is on allow list. Updateable by governance
    mapping(ISetToken => bool) public allowedSetTokens;

    // Boolean that returns if any SetToken can initialize this module. If false, then subject to allow list
    bool public anySetAllowed;
    
    /* ============ Constructor ============ */

    /**
     * Instantiate addresses. Underlying to reserve tokens mapping is created.
     * 
     * @param _controller                       Address of controller contract
     * @param _lendingPoolAddressesProvider     Address of Aave LendingPoolAddressProvider
     * @param _protocolDataProvider             Address of Aave ProtocolDataProvider
     */
    constructor(
        IController _controller,
        ILendingPoolAddressesProvider _lendingPoolAddressesProvider,
        IProtocolDataProvider _protocolDataProvider
    )
        public
        ModuleBase(_controller)
    {
        lendingPoolAddressesProvider = _lendingPoolAddressesProvider;
        protocolDataProvider = _protocolDataProvider;

        lendingPool = ILendingPool(_lendingPoolAddressesProvider.getLendingPool());
        
        IProtocolDataProvider.TokenData[] memory reserveTokens = protocolDataProvider.getAllReservesTokens();
        for(uint256 i = 0; i < reserveTokens.length; i++) {
            // todo: Emit AaveReserveUpdated event?
            _updateUnderlyingToReserveTokensMapping(IERC20(reserveTokens[i].tokenAddress));
        }
    }
    
    /**
     * MANAGER ONLY: Initializes this module to the SetToken. Only callable by the SetToken's manager. Note: managers can enable
     * collateral and borrow assets that don't exist as positions on the SetToken
     *
     * @param _setToken             Instance of the SetToken to initialize
     * @param _collateralAssets     Underlying tokens to be enabled as collateral in the SetToken
     * @param _borrowAssets         Underlying tokens to be enabled as borrow in the SetToken
     */
    function initialize(
        ISetToken _setToken,
        IERC20[] memory _collateralAssets,
        IERC20[] memory _borrowAssets
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
        require(_setToken.isInitializedModule(getAndValidateAdapter(DEFAULT_ISSUANCE_MODULE_NAME)), "Issuance not initialized");

        // Try if register exists on any of the modules including the debt issuance module
        address[] memory modules = _setToken.getModules();
        for(uint256 i = 0; i < modules.length; i++) {
            try IDebtIssuanceModule(modules[i]).registerToIssuanceModule(_setToken) {} catch {}
        }
        
        addCollateralAssets(_setToken, _collateralAssets);
        addBorrowAssets(_setToken, _borrowAssets);    
    }
    
    /**
     * MANAGER ONLY: Increases leverage for a given collateral position using an enabled borrow asset.
     * Performs a DEX trade, exchanging the borrow asset for collateral asset.
     *
     * @param _setToken             Instance of the SetToken
     * @param _borrowAsset          Address of asset being borrowed for leverage
     * @param _collateralAsset      Address of collateral reserve
     * @param _borrowQuantity       Borrow quantity of asset in position units
     * @param _minReceiveQuantity   Min receive quantity of collateral asset to receive post-trade in position units
     * @param _tradeAdapterName     Name of trade adapter
     * @param _tradeData            Arbitrary data for trade
     */
    function lever(
        ISetToken _setToken,
        IERC20 _borrowAsset,
        IERC20 _collateralAsset,
        uint256 _borrowQuantity,
        uint256 _minReceiveQuantity,
        string memory _tradeAdapterName,
        bytes memory _tradeData
    )
        external
        nonReentrant
        onlyManagerAndValidSet(_setToken)
    {
        // For levering up, send quantity is derived from borrow asset and receive quantity is derived from 
        // collateral asset
        ActionInfo memory leverInfo = _createAndValidateActionInfo(
            _setToken,
            _borrowAsset,
            _collateralAsset,
            _borrowQuantity,
            _minReceiveQuantity,
            _tradeAdapterName,
            true
        );

        _borrow(leverInfo.setToken, leverInfo.borrowAsset, leverInfo.notionalSendQuantity);

        uint256 postTradeReceiveQuantity = _executeTrade(leverInfo, _borrowAsset, _collateralAsset, _tradeData);

        uint256 protocolFee = _accrueProtocolFee(_setToken, _collateralAsset, postTradeReceiveQuantity);

        uint256 postTradeCollateralQuantity = postTradeReceiveQuantity.sub(protocolFee);

        _deposit(leverInfo.setToken, _collateralAsset, postTradeCollateralQuantity);

        _updateLeverPositions(leverInfo, _borrowAsset);

        emit LeverageIncreased(
            _setToken,
            _borrowAsset,
            _collateralAsset,
            leverInfo.exchangeAdapter,
            leverInfo.notionalSendQuantity,
            postTradeCollateralQuantity,
            protocolFee
        );
    }
    
    /**
     * MANAGER ONLY: Decrease leverage for a given collateral position using an enabled borrow asset that is enabled
     *
     * @param _setToken             Instance of the SetToken
     * @param _collateralAsset      Address of collateral asset (underlying of aToken)
     * @param _repayAsset           Address of asset being repaid
     * @param _redeemQuantity       Quantity of collateral asset to delever
     * @param _minRepayQuantity     Minimum amount of repay asset to receive post trade
     * @param _tradeAdapterName     Name of trade adapter
     * @param _tradeData            Arbitrary data for trade
     */
    function delever(
        ISetToken _setToken,
        IERC20 _collateralAsset,
        IERC20 _repayAsset,
        uint256 _redeemQuantity,
        uint256 _minRepayQuantity,
        string memory _tradeAdapterName,
        bytes memory _tradeData
    )
        external
        nonReentrant
        onlyManagerAndValidSet(_setToken)
    {
        // Note: for delevering, send quantity is derived from collateral asset and receive quantity is derived from 
        // repay asset
        ActionInfo memory deleverInfo = _createAndValidateActionInfo(
            _setToken,
            _collateralAsset,
            _repayAsset,
            _redeemQuantity,
            _minRepayQuantity,
            _tradeAdapterName,
            false
        );

        _withdraw(deleverInfo.setToken, _collateralAsset, deleverInfo.notionalSendQuantity);

        uint256 postTradeReceiveQuantity = _executeTrade(deleverInfo, _collateralAsset, _repayAsset, _tradeData);

        uint256 protocolFee = _accrueProtocolFee(_setToken, _repayAsset, postTradeReceiveQuantity);

        uint256 repayQuantity = postTradeReceiveQuantity.sub(protocolFee);

        _repayBorrow(deleverInfo.setToken, _repayAsset, repayQuantity);

        _updateLeverPositions(deleverInfo, _repayAsset);

        emit LeverageDecreased(
            _setToken,
            _collateralAsset,
            _repayAsset,
            deleverInfo.exchangeAdapter,
            deleverInfo.notionalSendQuantity,
            repayQuantity,
            protocolFee
        );
    }

    /**
     * MANAGER ONLY: Pays down the borrow asset to 0 selling off a given collateral asset. Any extra received
     * borrow asset is updated as equity. No protocol fee is charged.
     *
     * @param _setToken             Instance of the SetToken
     * @param _collateralAsset      Address of collateral asset (underlying of aToken)
     * @param _repayAsset           Address of asset being repaid (underlying asset e.g. DAI)
     * @param _redeemQuantity       Quantity of collateral asset to delever
     * @param _tradeAdapterName     Name of trade adapter
     * @param _tradeData            Arbitrary data for trade
     *
     * @return uint256              Notional repay quantity
     */
    function deleverToZeroBorrowBalance(
        ISetToken _setToken,
        IERC20 _collateralAsset,
        IERC20 _repayAsset,
        uint256 _redeemQuantity,
        string memory _tradeAdapterName,
        bytes memory _tradeData
    )
        external
        nonReentrant
        onlyManagerAndValidSet(_setToken)
        returns (uint256)
    {
        uint256 notionalRedeemQuantity = _redeemQuantity.preciseMul(_setToken.totalSupply());
        
        require(borrowAssetEnabled[_setToken][_repayAsset], "Borrow not enabled");
        uint256 notionalRepayQuantity = underlyingToReserveTokens[_repayAsset].variableDebtToken.balanceOf(address(_setToken));

        ActionInfo memory deleverInfo = _createAndValidateActionInfoNotional(
            _setToken,
            _collateralAsset,
            _repayAsset,
            notionalRedeemQuantity,
            notionalRepayQuantity,
            _tradeAdapterName,
            false
        );

        _withdraw(deleverInfo.setToken, _collateralAsset, deleverInfo.notionalSendQuantity);

        _executeTrade(deleverInfo, _collateralAsset, _repayAsset, _tradeData);

        _repayBorrow(deleverInfo.setToken, _repayAsset, notionalRepayQuantity);

        // Update default position first to save gas on editing borrow position
        _setToken.calculateAndEditDefaultPosition(
            address(_repayAsset),
            deleverInfo.setTotalSupply,
            deleverInfo.preTradeReceiveTokenBalance
        );

        _updateLeverPositions(deleverInfo, _repayAsset);

        emit LeverageDecreased(
            _setToken,
            _collateralAsset,
            _repayAsset,
            deleverInfo.exchangeAdapter,
            deleverInfo.notionalSendQuantity,
            notionalRepayQuantity,
            0   // No protocol fee
        );

        return notionalRepayQuantity;
    }

    /**
     * CALLABLE BY ANYBODY: Sync Set positions with enabled Aave collateral and borrow positions. For collateral 
     * assets, update aToken default position. For borrow assets, update external borrow position.
     * - Collateral assets may come out of sync when interest is accrued or a a position is liquidated
     * - Borrow assets may come out of sync when interest is accrued or position is liquidated and borrow is repaid
     * Note: In Aave, both collateral and borrow interest is accrued in each block by increasing the balance of aTokens & debtTokens
     * for each user, and 1 aToken = 1 stableDebtToken = 1 variableDebtToken = 1 underlying.
     *
     * @param _setToken               Instance of the SetToken
     */
    function sync(ISetToken _setToken) public nonReentrant onlyValidAndInitializedSet(_setToken) {
        uint256 setTotalSupply = _setToken.totalSupply();

        // Only sync positions when Set supply is not 0. Without this check, if sync is called by someone before the 
        // first issuance, then editDefaultPosition would remove the default positions from the SetToken
        if (setTotalSupply > 0) {
            // Loop through collateral assets
            address[] memory collateralAssets = enabledAssets[_setToken].collateralAssets;
            for(uint256 i = 0; i < collateralAssets.length; i++) {
                IAToken aToken = underlyingToReserveTokens[IERC20(collateralAssets[i])].aToken;
                
                uint256 previousPositionUnit = _setToken.getDefaultPositionRealUnit(address(aToken)).toUint256();
                uint256 newPositionUnit = _getCollateralPosition(_setToken, aToken, setTotalSupply);

                // Note: Accounts for if position does not exist on SetToken but is tracked in enabledAssets
                if (previousPositionUnit != newPositionUnit) {
                  _updateCollateralPosition(_setToken, aToken, newPositionUnit);
                }
            }
        
            address[] memory borrowAssets = enabledAssets[_setToken].borrowAssets;
            for(uint256 i = 0; i < borrowAssets.length; i++) {
                
                int256 previousPositionUnit = _setToken.getExternalPositionRealUnit(borrowAssets[i], address(this));
                int256 newPositionUnit = _getBorrowPosition(_setToken, IERC20(borrowAssets[i]), setTotalSupply);

                // Note: Accounts for if position does not exist on SetToken but is tracked in enabledAssets
                if (newPositionUnit != previousPositionUnit) {
                    _updateBorrowPosition(_setToken, IERC20(borrowAssets[i]), newPositionUnit);
                }
            }
        }
    }

    /**
     * MANAGER ONLY: Add collateral assets. aTokens corresponding to collateral assets are tracked for syncing positions.
     *
     * @param _setToken             Instance of the SetToken
     * @param _newCollateralAssets  Addresses of new collateral underlying assets
     */
    function addCollateralAssets(ISetToken _setToken, IERC20[] memory _newCollateralAssets) public onlyManagerAndValidSet(_setToken) {
        for(uint256 i = 0; i < _newCollateralAssets.length; i++) {
            IERC20 collateralAsset = _newCollateralAssets[i];
            
            _validateNewCollateralAsset(_setToken, collateralAsset);
            _updateUnderlyingToReserveTokensMapping(collateralAsset);
            
            collateralAssetEnabled[_setToken][collateralAsset] = true;
            enabledAssets[_setToken].collateralAssets.push(address(collateralAsset));
        }
        emit CollateralAssetsUpdated(_setToken, true, _newCollateralAssets);
    }
    
    /**
     * MANAGER ONLY: Add borrow asset. Debt tokens corresponding to borrow assets are tracked for syncing positions.
     *
     * @param _setToken             Instance of the SetToken
     * @param _newBorrowAssets      Addresses of borrow underlying assets to add
     */
    function addBorrowAssets(ISetToken _setToken, IERC20[] memory _newBorrowAssets) public onlyManagerAndValidSet(_setToken) {
        for(uint256 i = 0; i < _newBorrowAssets.length; i++) {
            IERC20 borrowAsset = _newBorrowAssets[i];
            
            _validateNewBorrowAsset(_setToken, borrowAsset);
            _updateUnderlyingToReserveTokensMapping(borrowAsset);
            
            borrowAssetEnabled[_setToken][borrowAsset] = true;
            enabledAssets[_setToken].borrowAssets.push(address(borrowAsset));
        }
        emit BorrowAssetsUpdated(_setToken, true, _newBorrowAssets);
    }
        
    /**
     * MANAGER ONLY: Add registration of this module on debt issuance module for the SetToken. Note: if the debt issuance module is not added to SetToken
     * before this module is initialized, then this function needs to be called if the debt issuance module is later added and initialized to prevent state
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
     * MODULE ONLY: Hook called prior to issuance to sync positions on SetToken. Only callable by valid module.
     *
     * @param _setToken             Instance of the SetToken
     */
    function moduleIssueHook(ISetToken _setToken, uint256 /* _setTokenQuantity */) external onlyModule(_setToken) {
        sync(_setToken);
    }

    /**
     * MODULE ONLY: Hook called prior to redemption to sync positions on SetToken. For redemption, always use current borrowed balance after interest accrual.
     * Only callable by valid module.
     *
     * @param _setToken             Instance of the SetToken
     */
    function moduleRedeemHook(ISetToken _setToken, uint256 /* _setTokenQuantity */) external onlyModule(_setToken) {
        sync(_setToken);
    }

    /**
     * MODULE ONLY: Hook called prior to looping through each component on issuance. Invokes borrow in order for 
     * module to return debt to issuer. Only callable by valid module.
     *
     * @param _setToken             Instance of the SetToken
     * @param _setTokenQuantity     Quantity of SetToken
     * @param _component            Address of component
     */
    function componentIssueHook(ISetToken _setToken, uint256 _setTokenQuantity, IERC20 _component, bool /* _isEquity */) external onlyModule(_setToken) {
        int256 componentDebt = _setToken.getExternalPositionRealUnit(address(_component), address(this));

        require(componentDebt < 0, "Component must be negative");

        uint256 notionalDebt = componentDebt.mul(-1).toUint256().preciseMulCeil(_setTokenQuantity);
        _borrow(_setToken, _component, notionalDebt);
    }

    /**
     * MODULE ONLY: Hook called prior to looping through each component on redemption. Invokes repay after 
     * issuance module transfers debt from issuer. Only callable by valid module.
     *
     * @param _setToken             Instance of the SetToken
     * @param _setTokenQuantity     Quantity of SetToken
     * @param _component            Address of component
     */
    function componentRedeemHook(ISetToken _setToken, uint256 _setTokenQuantity, IERC20 _component, bool /* _isEquity */) external onlyModule(_setToken) {
        int256 componentDebt = _setToken.getExternalPositionRealUnit(address(_component), address(this));

        require(componentDebt < 0, "Component must be negative");

        uint256 notionalDebt = componentDebt.mul(-1).toUint256().preciseMulCeil(_setTokenQuantity);
        _repayBorrow(_setToken, _component, notionalDebt);
    }
        
    /**
     * MANAGER ONLY: Removes this module from the SetToken, via call by the SetToken. Any deposited collateral assets
     * are disabled to be used as collateral on Aave. Aave Settings and manager enabled assets state is deleted.      
     * Note: Function will revert is there is any debt remaining on Aave
     */
    function removeModule() external override onlyValidAndInitializedSet(ISetToken(msg.sender)) {
        ISetToken setToken = ISetToken(msg.sender);

        // Sync Aave and SetToken positions prior to any removal action
        sync(setToken);

        address[] memory borrowAssets = enabledAssets[setToken].borrowAssets;
        for(uint256 i = 0; i < borrowAssets.length; i++) {
            IERC20 borrowAsset = IERC20(borrowAssets[i]);
            require(underlyingToReserveTokens[borrowAsset].variableDebtToken.balanceOf(address(setToken)) == 0, "Variable debt remaining");
    
            delete borrowAssetEnabled[setToken][borrowAsset];
        }

        address[] memory collateralAssets = enabledAssets[setToken].collateralAssets;
        for(uint256 i = 0; i < collateralAssets.length; i++) {
            delete collateralAssetEnabled[setToken][IERC20(collateralAssets[i])];
        }
        
        delete enabledAssets[setToken];

        // Try if unregister exists on any of the modules
        address[] memory modules = setToken.getModules();
        for(uint256 i = 0; i < modules.length; i++) {
            try IDebtIssuanceModule(modules[i]).unregisterFromIssuanceModule(setToken) {} catch {}
        }
    }
    
    /**
     * MANAGER ONLY: Remove collateral asset. Disable deposited assets to be used as collateral on Aave market.
     * todo: If there is a borrow balance, collateral asset cannot be removed? Should we check for health factor as well?
     *
     * @param _setToken             Instance of the SetToken
     * @param _collateralAssets     Addresses of collateral underlying assets to remove
     */
    function removeCollateralAssets(ISetToken _setToken, IERC20[] memory _collateralAssets) external onlyManagerAndValidSet(_setToken) {
        // Sync Aave and SetToken positions prior to any removal action
        sync(_setToken);
        
        for(uint256 i = 0; i < _collateralAssets.length; i++) {
            IERC20 collateralAsset = _collateralAssets[i];
            require(collateralAssetEnabled[_setToken][collateralAsset], "Collateral not enabled");
            delete collateralAssetEnabled[_setToken][collateralAsset];
            enabledAssets[_setToken].collateralAssets.removeStorage(address(collateralAsset));
        }
        
        emit CollateralAssetsUpdated(_setToken, false, _collateralAssets);
    }

    /**
     * MANAGER ONLY: Remove borrow asset.
     * Note: If there is a borrow balance, borrow asset cannot be removed
     *
     * @param _setToken             Instance of the SetToken
     * @param _borrowAssets         Addresses of borrow underlying assets to remove
     */
    function removeBorrowAssets(ISetToken _setToken, IERC20[] memory _borrowAssets) external onlyManagerAndValidSet(_setToken) {
        // Sync Aave and SetToken positions prior to any removal action
        sync(_setToken);
        
        for(uint256 i = 0; i < _borrowAssets.length; i++) {
            IERC20 borrowAsset = _borrowAssets[i];
            
            require(borrowAssetEnabled[_setToken][borrowAsset], "Borrow not enabled");
            require(underlyingToReserveTokens[borrowAsset].variableDebtToken.balanceOf(address(_setToken)) == 0, "Variable debt remaining");
    
            delete borrowAssetEnabled[_setToken][borrowAsset];
            enabledAssets[_setToken].borrowAssets.removeStorage(address(borrowAsset));
        }
        emit BorrowAssetsUpdated(_setToken, false, _borrowAssets);
    }

    /**
     * GOVERNANCE ONLY: Add or remove allowed SetToken to initialize this module. Only callable by governance.
     *
     * @param _setToken             Instance of the SetToken
     */
    function updateAllowedSetToken(ISetToken _setToken, bool _status) external onlyOwner {
        allowedSetTokens[_setToken] = _status;
        emit SetTokenStatusUpdated(_setToken, _status);
    }

    /**
     * GOVERNANCE ONLY: Toggle whether any SetToken is allowed to initialize this module. Only callable by governance.
     *
     * @param _anySetAllowed             Bool indicating whether allowedSetTokens is enabled
     */
    function updateAnySetAllowed(bool _anySetAllowed) external onlyOwner {
        anySetAllowed = _anySetAllowed;
        emit AnySetAllowedUpdated(_anySetAllowed);
    }

    /**
     * CALLABLE BY ANYBODY: Updates `underlyingToReserveTokens` mappings. Adds a new mapping for previously untracked reserves.
     * Aave's reserve tokens are mutable and their addresses can be changed. This function upates the stored reserve token addresses
     * to their latest value.
     * Note: Use this function for adding new reserves to `underlyingToReserveTokens` mapping.
     *
     * @param _underlying               Address of underlying asset
     */
    function updateUnderlyingToReserveTokensMapping(IERC20 _underlying) external {
        _updateUnderlyingToReserveTokensMapping(_underlying);
        emit AaveReserveUpdated(_underlying, underlyingToReserveTokens[_underlying]);
    }

    /**
     * CALLABLE BY ANYBODY: Updates AaveV2 LendingPool contract. Aave's LendingPool contract is mutable and is address 
     * can be changed. This function updates the lendingPool to its latest address.
     * 
     */
    function updateLendingPool() external {
        lendingPool = ILendingPool(lendingPoolAddressesProvider.getLendingPool());
        emit LendingPoolUpdated(lendingPool);
    }
    
    /* ============ External Getter Functions ============ */

    /**
     * Get enabled assets for SetToken. Returns an array of collateral and borrow assets.
     *
     * @return                    Underlying collateral assets that are enabled
     * @return                    Underlying borrowed assets that are enabled
     */
    function getEnabledAssets(ISetToken _setToken) external view returns(address[] memory, address[] memory) {
        return (
            enabledAssets[_setToken].collateralAssets,
            enabledAssets[_setToken].borrowAssets
        );
    }

    /* ============ Internal Functions ============ */
    
    /**
     * Invoke deposit from SetToken. Mints aTokens for SetToken.
     */
    function _deposit(ISetToken _setToken, IERC20 _asset, uint256 _notionalQuantity) internal {
        _setToken.invokeApprove(address(_asset), address(lendingPool), _notionalQuantity);
        _setToken.invokeDeposit(lendingPool, address(_asset), _notionalQuantity);
    }

    /**
     * Invoke withdraw from SetToken. Burns aTokens and returns underlying to SetToken.
     */
    function _withdraw(ISetToken _setToken, IERC20 _asset, uint256 _notionalQuantity) internal {
        _setToken.invokeWithdraw(lendingPool, address(_asset), _notionalQuantity);
    }

    /**
     * Invoke borrow from the SetToken. Mints DebtTokens for SetToken.
     */
    function _borrow(ISetToken _setToken, IERC20 _asset, uint256 _notionalQuantity) internal {
        _setToken.invokeBorrow(lendingPool, address(_asset), _notionalQuantity, BORROW_RATE_MODE);
    }

    /**
     * Invoke repay from SetToken. Burns DebtTokens for SetToken.
     */
    function _repayBorrow(ISetToken _setToken, IERC20 _asset, uint256 _notionalQuantity) internal {
        _setToken.invokeApprove(address(_asset), address(lendingPool), _notionalQuantity);
        _setToken.invokeRepay(lendingPool, address(_asset), _notionalQuantity, BORROW_RATE_MODE);
    }

    /**
     * Construct the ActionInfo struct for lever and delever
     *
     * @return ActionInfo       Instance of constructed ActionInfo struct
     */
    function _createAndValidateActionInfo(
        ISetToken _setToken,
        IERC20 _sendToken,
        IERC20 _receiveToken,
        uint256 _sendQuantityUnits,
        uint256 _minReceiveQuantityUnits,
        string memory _tradeAdapterName,
        bool _isLever
    )
        internal
        view
        returns(ActionInfo memory)
    {
        uint256 totalSupply = _setToken.totalSupply();

        return _createAndValidateActionInfoNotional(
            _setToken,
            _sendToken,
            _receiveToken,
            _sendQuantityUnits.preciseMul(totalSupply),
            _minReceiveQuantityUnits.preciseMul(totalSupply),
            _tradeAdapterName,
            _isLever
        );
    }
    
    /**
     * Construct the ActionInfo struct for lever and delever accepting notional units
     *
     * @return ActionInfo       Instance of constructed ActionInfo struct
     */
    function _createAndValidateActionInfoNotional(
        ISetToken _setToken,
        IERC20 _sendToken,
        IERC20 _receiveToken,
        uint256 _notionalSendQuantity,
        uint256 _minNotionalReceiveQuantity,
        string memory _tradeAdapterName,
        bool _isLever
    )
        internal
        view
        returns(ActionInfo memory)
    {
        uint256 totalSupply = _setToken.totalSupply();
        ActionInfo memory actionInfo = ActionInfo ({
            exchangeAdapter: IExchangeAdapter(getAndValidateAdapter(_tradeAdapterName)),
            setToken: _setToken,
            collateralAsset: _isLever ? _receiveToken : _sendToken,
            borrowAsset: _isLever ? _sendToken : _receiveToken,
            setTotalSupply: totalSupply,
            notionalSendQuantity: _notionalSendQuantity,
            minNotionalReceiveQuantity: _minNotionalReceiveQuantity,
            preTradeReceiveTokenBalance: IERC20(_receiveToken).balanceOf(address(_setToken))
        });

        _validateCommon(actionInfo);

        return actionInfo;
    }
    
    /**
     * Invokes approvals, gets trade call data from exchange adapter and invokes trade from SetToken
     *
     * @return uint256     The quantity of tokens received post-trade
     */
    function _executeTrade(
        ActionInfo memory _actionInfo,
        IERC20 _sendToken,
        IERC20 _receiveToken,
        bytes memory _data
    )
        internal
        returns (uint256)
    {
        ISetToken setToken = _actionInfo.setToken;
        uint256 notionalSendQuantity = _actionInfo.notionalSendQuantity;

        setToken.invokeApprove(
            address(_sendToken),
            _actionInfo.exchangeAdapter.getSpender(),
            notionalSendQuantity
        );

        (
            address targetExchange,
            uint256 callValue,
            bytes memory methodData
        ) = _actionInfo.exchangeAdapter.getTradeCalldata(
            address(_sendToken),
            address(_receiveToken),
            address(setToken),
            notionalSendQuantity,
            _actionInfo.minNotionalReceiveQuantity,
            _data
        );

        setToken.invoke(targetExchange, callValue, methodData);

        uint256 receiveTokenQuantity = _receiveToken.balanceOf(address(setToken)).sub(_actionInfo.preTradeReceiveTokenBalance);
        require(
            receiveTokenQuantity >= _actionInfo.minNotionalReceiveQuantity,
            "Slippage too high"
        );

        return receiveTokenQuantity;
    }

    /**
     * Calculates protocol fee on module and pays protocol fee from SetToken
     *
     * @return uint256          Total protocol fee paid
     */
    function _accrueProtocolFee(ISetToken _setToken, IERC20 _receiveToken, uint256 _exchangedQuantity) internal returns(uint256) {
        uint256 protocolFeeTotal = getModuleFee(PROTOCOL_TRADE_FEE_INDEX, _exchangedQuantity);
        
        payProtocolFeeFromSetToken(_setToken, address(_receiveToken), protocolFeeTotal);

        return protocolFeeTotal;
    }

    /**
     * Updates the collateral (aToken held) and borrow position (variableDebtToken held) of the SetToken
     */
    function _updateLeverPositions(ActionInfo memory actionInfo, IERC20 _borrowAsset) internal {
        _updateCollateralPosition(
            actionInfo.setToken,
            underlyingToReserveTokens[actionInfo.collateralAsset].aToken,
            _getCollateralPosition(
                actionInfo.setToken,
                underlyingToReserveTokens[actionInfo.collateralAsset].aToken,
                actionInfo.setTotalSupply
            )
        );

        _updateBorrowPosition(
            actionInfo.setToken,
            _borrowAsset,
            _getBorrowPosition(
                actionInfo.setToken,
                _borrowAsset,
                actionInfo.setTotalSupply
            )
        );
    }
    
    /**
     * Reads aToken balance and calculates default position unit for given collateral aToken and SetToken
     *
     * @return uint256       default collateral position unit          
     */
    function _getCollateralPosition(ISetToken _setToken, IAToken _aToken, uint256 _setTotalSupply) internal view returns (uint256) {
        uint256 collateralNotionalBalance = _aToken.balanceOf(address(_setToken));
        return collateralNotionalBalance.preciseDiv(_setTotalSupply);
    }
    
    /**
     * Reads variableDebtToken balance and calculates external position unit for given borrow asset and SetToken
     *
     * @return int256       external borrow position unit
     */
    function _getBorrowPosition(ISetToken _setToken, IERC20 _borrowAsset, uint256 _setTotalSupply) internal view returns (int256) {
        uint256 borrowNotionalBalance = underlyingToReserveTokens[_borrowAsset].variableDebtToken.balanceOf(address(_setToken));
        return borrowNotionalBalance.preciseDiv(_setTotalSupply).toInt256().mul(-1);
    }
    
    /**
     * Updates default position unit for given aToken on SetToken
     */
    function _updateCollateralPosition(ISetToken _setToken, IAToken _aToken, uint256 _newPositionUnit) internal {
        _setToken.editDefaultPosition(address(_aToken), _newPositionUnit);
    }

    /**
     * Updates external position unit for given borrow asset on SetToken
     */
    function _updateBorrowPosition(ISetToken _setToken, IERC20 _underlyingAsset, int256 _newPositionUnit) internal {
        _setToken.editExternalPosition(address(_underlyingAsset), address(this), _newPositionUnit, "");
    }
   
    /**
     * Updates `underlyingToReserveTokens` mappings for given `_underlying` asset
     */
    function _updateUnderlyingToReserveTokensMapping(IERC20 _underlying) internal {
        // Note: Returns zero addresses if specified reserve is not present on Aave market
        (address aToken, , address variableDebtToken) = protocolDataProvider.getReserveTokensAddresses(address(_underlying));
        
        underlyingToReserveTokens[_underlying].aToken = IAToken(aToken);
        underlyingToReserveTokens[_underlying].variableDebtToken = IVariableDebtToken(variableDebtToken);
    }   

    /**
     * Validates if a new asset can be added as collateral asset for given SetToken
     */
    function _validateNewCollateralAsset(ISetToken _setToken, IERC20 _collateralAsset) internal view {
        require(!collateralAssetEnabled[_setToken][_collateralAsset], "Collateral already enabled");
        (,,,,, bool usageAsCollateralEnabled,,, bool isActive, bool isFrozen) = protocolDataProvider.getReserveConfigurationData(address(_collateralAsset));
        // An active reserve is an alias for a valid reserve on Aave.
        // We are checking for the availability of the reserve directly on Aave rather than checking our internal `underlyingToResrveTokens` mappings, 
        // becuase our mappings can be out-of-date if a new reserve is added to Aave        
        require(isActive, "Invalid aave reserve");
        // Forzen reserve doesn't allow any new deposit or borrow but allows repayments and withdrawals.
        require(!isFrozen, "Frozen aave reserve");
        require(usageAsCollateralEnabled, "Collateral disabled on Aave");
    }

    /**
     * Validates if a new asset can be added as borrow asset for given SetToken
     */
    function _validateNewBorrowAsset(ISetToken _setToken, IERC20 _borrowAsset) internal view {
        require(!borrowAssetEnabled[_setToken][_borrowAsset], "Borrow already enabled");    
        (, , , , , , bool borrowingEnabled, , bool isActive, bool isFrozen) = protocolDataProvider.getReserveConfigurationData(address(_borrowAsset));
        require(isActive, "Invalid aave reserve");
        require(!isFrozen, "Frozen aave reserve");
        require(borrowingEnabled, "Borrowing disabled on Aave");
    }

    /**
     * Validate common requirements for lever and delever
     */
    function _validateCommon(ActionInfo memory _actionInfo) internal view {
        require(collateralAssetEnabled[_actionInfo.setToken][_actionInfo.collateralAsset], "Collateral not enabled");
        require(borrowAssetEnabled[_actionInfo.setToken][_actionInfo.borrowAsset], "Borrow not enabled");
        require(_actionInfo.collateralAsset != _actionInfo.borrowAsset, "Must be different");
        require(_actionInfo.notionalSendQuantity > 0, "Quantity is 0");
    }
}