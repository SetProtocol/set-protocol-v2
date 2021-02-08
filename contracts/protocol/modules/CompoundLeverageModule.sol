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

import { ICErc20 } from "../../interfaces/external/ICErc20.sol";
import { IComptroller } from "../../interfaces/external/IComptroller.sol";
import { IController } from "../../interfaces/IController.sol";
import { IDebtIssuanceModule } from "../../interfaces/IDebtIssuanceModule.sol";
import { IExchangeAdapter } from "../../interfaces/IExchangeAdapter.sol";
import { ISetToken } from "../../interfaces/ISetToken.sol";
import { ModuleBase } from "../lib/ModuleBase.sol";

/**
 * @title CompoundLeverageModule
 * @author Set Protocol
 *
 * Smart contract that enables leverage trading using Compound as the lending protocol. This module is paired with a debt issuance module that will call
 * functions on this module to keep interest accrual and liquidation state updated. This does not allow borrowing of assets from Compound alone. Each 
 * asset is leveraged when using this module.
 *
 * Note: Do not use this module in conjunction with other debt modules that allow Compound debt positions as it could lead to double counting of
 * debt when borrowed assets are the same.
 *
 */
contract CompoundLeverageModule is ModuleBase, ReentrancyGuard, Ownable {

    /* ============ Structs ============ */

    struct EnabledAssets {
        address[] collateralCTokens;             // Array of enabled cToken collateral assets for a SetToken
        address[] borrowCTokens;                 // Array of enabled cToken borrow assets for a SetToken
        address[] borrowAssets;                  // Array of underlying borrow assets that map to the array of enabled cToken borrow assets
    }

    struct ActionInfo {
        ISetToken setToken;                      // SetToken instance
        IExchangeAdapter exchangeAdapter;        // Exchange adapter instance
        uint256 setTotalSupply;                  // Total supply of SetToken
        uint256 notionalSendQuantity;            // Total notional quantity sent to exchange
        uint256 minNotionalReceiveQuantity;      // Min total notional received from exchange
        address collateralCTokenAsset;           // Address of cToken collateral asset
        address borrowCTokenAsset;               // Address of cToken borrow asset
        uint256 preTradeReceiveTokenBalance;     // Balance of pre trade receive token balance
    }

    /* ============ Events ============ */

    event LeverageIncreased(
        ISetToken indexed _setToken,
        address indexed _borrowAsset,
        address indexed _collateralAsset,
        IExchangeAdapter _exchangeAdapter,
        uint256 _totalBorrowAmount,
        uint256 _totalReceiveAmount,
        uint256 _protocolFee
    );

    event LeverageDecreased(
        ISetToken indexed _setToken,
        address indexed _collateralAsset,
        address indexed _repayAsset,
        IExchangeAdapter _exchangeAdapter,
        uint256 _totalRedeemAmount,
        uint256 _totalRepayAmount,
        uint256 _protocolFee
    );

    event CompGulped(
        ISetToken indexed _setToken,
        address indexed _collateralAsset,
        IExchangeAdapter _exchangeAdapter,
        uint256 _totalCompClaimed,
        uint256 _totalReceiveAmount,
        uint256 _protocolFee
    );

    event PositionsSynced(
        ISetToken indexed _setToken,
        address _caller
    );

    event CollateralAssetsAdded(
        ISetToken indexed _setToken,
        address[] _assets
    );

    event CollateralAssetsRemoved(
        ISetToken indexed _setToken,
        address[] _assets
    );

    event BorrowAssetsAdded(
        ISetToken indexed _setToken,
        address[] _assets
    );

    event BorrowAssetsRemoved(
        ISetToken indexed _setToken,
        address[] _assets
    );

    /* ============ Constants ============ */

    // String identifying the DebtIssuanceModule in the IntegrationRegistry. Note: Governance must add DefaultIssuanceModule as
    // the string as the integration name
    string constant internal DEFAULT_ISSUANCE_MODULE_NAME = "DefaultIssuanceModule";

    // 0 index stores protocol fee % on the controller, charged in the trade function
    uint256 constant internal PROTOCOL_TRADE_FEE_INDEX = 0;

    /* ============ State Variables ============ */

    // Mapping of underlying to CToken. If ETH, then map WETH to cETH
    mapping(address => address) public underlyingToCToken;

    // Wrapped Ether address
    address internal weth;

    // Compound cEther address
    address internal cEther;

    // Compound Comptroller contract
    IComptroller internal comptroller;

    // COMP token address
    address internal compToken;

    // Mapping to efficiently check if cToken market for collateral asset is valid in SetToken
    mapping(ISetToken => mapping(address => bool)) public isCollateralCTokenEnabled;

    // Mapping to efficiently check if cToken market for borrow asset is valid in SetToken
    mapping(ISetToken => mapping(address => bool)) public isBorrowCTokenEnabled;

    // Mapping of enabled collateral and borrow cTokens for syncing positions
    mapping(ISetToken => EnabledAssets) internal enabledAssets;

    // Mapping of SetToken to boolean indicating if SetToken is on allow list. Updateable by governance
    mapping(ISetToken => bool) public allowList;

    // Boolean that returns if any SetToken can initialize this module. If false, then subject to allow list
    bool public anySetInitializable;


    /* ============ Constructor ============ */

    /**
     * Instantiate addresses. Underlying to cToken mapping is created.
     * 
     * @param _controller               Address of controller contract
     * @param _compToken                Address of COMP token
     * @param _comptroller              Address of Compound Comptroller
     * @param _cEther                   Address of cEther contract
     * @param _weth                     Address of WETH contract
     */
    constructor(
        IController _controller,
        address _compToken,
        IComptroller _comptroller,
        address _cEther,
        address _weth
    )
        public
        ModuleBase(_controller)
    {
        compToken = _compToken;
        comptroller = _comptroller;
        cEther = _cEther;
        weth = _weth;

        ICErc20[] memory cTokens = comptroller.getAllMarkets();

        for(uint256 i = 0; i < cTokens.length; i++) {
            if (address(cTokens[i]) == _cEther) {
                underlyingToCToken[_weth] = address(cTokens[i]);
            } else {
                address underlying = cTokens[i].underlying();
                underlyingToCToken[underlying] = address(cTokens[i]);
            }
        }
    }

    /* ============ External Functions ============ */

    /**
     * MANAGER ONLY: Increases leverage for a given collateral position using an enabled borrow asset that is enabled.
     * Performs a DEX trade, exchanging the borrow asset for collateral asset.
     *
     * @param _setToken             Instance of the SetToken
     * @param _borrowAsset          Address of asset being borrowed for leverage
     * @param _collateralAsset      Address of collateral asset (underlying of cToken)
     * @param _borrowQuantity       Borrow quantity of asset in position units
     * @param _minReceiveQuantity   Min receive quantity of collateral asset to receive post-trade in position units
     * @param _tradeAdapterName     Name of trade adapter
     * @param _tradeData            Arbitrary data for trade
     */
    function lever(
        ISetToken _setToken,
        address _borrowAsset,
        address _collateralAsset,
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
        ActionInfo memory leverInfo = _createActionInfo(
            _setToken,
            _borrowAsset,
            _collateralAsset,
            _borrowQuantity,
            _minReceiveQuantity,
            _tradeAdapterName,
            true
        );

        _validateCommon(leverInfo);

        _borrow(leverInfo.setToken, leverInfo.borrowCTokenAsset, leverInfo.notionalSendQuantity);

        (uint256 protocolFee, uint256 postTradeCollateralQuantity) = _tradeAndHandleFees(
            _setToken,
            _borrowAsset,
            _collateralAsset,
            leverInfo.notionalSendQuantity,
            leverInfo.minNotionalReceiveQuantity,
            leverInfo.preTradeReceiveTokenBalance,
            leverInfo.exchangeAdapter,
            _tradeData
        );

        _mintCToken(leverInfo.setToken, leverInfo.collateralCTokenAsset, _collateralAsset, postTradeCollateralQuantity);

        _updateCollateralPosition(
            leverInfo.setToken,
            leverInfo.collateralCTokenAsset,
            _getCollateralPosition(
                leverInfo.setToken,
                leverInfo.collateralCTokenAsset,
                leverInfo.setTotalSupply
            )
        );

        _updateBorrowPosition(
            leverInfo.setToken,
            _borrowAsset,
            _getBorrowPosition(
                leverInfo.setToken,
                leverInfo.borrowCTokenAsset,
                leverInfo.setTotalSupply
            )
        );

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
     * @param _collateralAsset      Address of collateral asset (underlying of cToken)
     * @param _repayAsset           Address of asset being repaid
     * @param _redeemQuantity       Quantity of collateral asset to delever
     * @param _minRepayQuantity     Minimum amount of repay asset to receive post trade
     * @param _tradeAdapterName     Name of trade adapter
     * @param _tradeData            Arbitrary data for trade
     */
    function delever(
        ISetToken _setToken,
        address _collateralAsset,
        address _repayAsset,
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
        ActionInfo memory deleverInfo = _createActionInfo(
            _setToken,
            _collateralAsset,
            _repayAsset,
            _redeemQuantity,
            _minRepayQuantity,
            _tradeAdapterName,
            false
        );

        _validateCommon(deleverInfo);

        _redeemUnderlying(deleverInfo.setToken, deleverInfo.collateralCTokenAsset, deleverInfo.notionalSendQuantity);

        (uint256 protocolFee, uint256 postTradeRepayQuantity) = _tradeAndHandleFees(
            _setToken,
            _collateralAsset,
            _repayAsset,
            deleverInfo.notionalSendQuantity,
            deleverInfo.minNotionalReceiveQuantity,
            deleverInfo.preTradeReceiveTokenBalance,
            deleverInfo.exchangeAdapter,
            _tradeData
        );

        _repayBorrow(deleverInfo.setToken, deleverInfo.borrowCTokenAsset, _repayAsset, postTradeRepayQuantity);

        _updateCollateralPosition(
            deleverInfo.setToken,
            deleverInfo.collateralCTokenAsset,
            _getCollateralPosition(deleverInfo.setToken, deleverInfo.collateralCTokenAsset, deleverInfo.setTotalSupply)
        );

        _updateBorrowPosition(
            deleverInfo.setToken,
            _repayAsset,
            _getBorrowPosition(deleverInfo.setToken, deleverInfo.borrowCTokenAsset, deleverInfo.setTotalSupply)
        );

        emit LeverageDecreased(
            _setToken,
            _collateralAsset,
            _repayAsset,
            deleverInfo.exchangeAdapter,
            deleverInfo.notionalSendQuantity,
            postTradeRepayQuantity,
            protocolFee
        );
    }

    /**
     * MANAGER ONLY: Claims COMP and trades for specified collateral asset. If collateral asset is COMP, then no trade occurs
     * and min notional reapy quantity, trade adapter name and trade data parameters are not used.
     *
     * @param _setToken                      Instance of the SetToken
     * @param _collateralAsset               Address of underlying cToken asset
     * @param _minNotionalReceiveQuantity    Minimum total amount of collateral asset to receive post trade
     * @param _tradeAdapterName              Name of trade adapter
     * @param _tradeData                     Arbitrary data for trade
     */
    function gulp(
        ISetToken _setToken,
        address _collateralAsset,
        uint256 _minNotionalReceiveQuantity,
        string memory _tradeAdapterName,
        bytes memory _tradeData
    )
        external
        nonReentrant
        onlyManagerAndValidSet(_setToken)
    {
        // Claim COMP. Note: COMP can be claimed by anyone for any address
        comptroller.claimComp(address(_setToken));

        ActionInfo memory gulpInfo = _createGulpInfoAndValidate(
            _setToken,
            _collateralAsset,
            _tradeAdapterName
        );

        uint256 protocolFee;
        uint256 postTradeCollateralQuantity;
        if (_collateralAsset == compToken) {
            // If specified collateral asset is COMP, then skip trade and set post trade collateral quantity
            postTradeCollateralQuantity = gulpInfo.preTradeReceiveTokenBalance;
        } else {
            (protocolFee, postTradeCollateralQuantity) = _tradeAndHandleFees(
                _setToken,
                compToken,
                _collateralAsset,
                gulpInfo.notionalSendQuantity,
                _minNotionalReceiveQuantity,
                gulpInfo.preTradeReceiveTokenBalance,
                gulpInfo.exchangeAdapter,
                _tradeData
            );
        }

        _mintCToken(_setToken, gulpInfo.collateralCTokenAsset, _collateralAsset, postTradeCollateralQuantity);

        _updateCollateralPosition(
            _setToken,
            gulpInfo.collateralCTokenAsset,
            _getCollateralPosition(_setToken, gulpInfo.collateralCTokenAsset, gulpInfo.setTotalSupply)
        );

        emit CompGulped(
            _setToken,
            _collateralAsset,
            gulpInfo.exchangeAdapter,
            gulpInfo.notionalSendQuantity,
            postTradeCollateralQuantity,
            protocolFee
        );
    }

    /**
     * CALLABLE BY ANYBODY: Sync Set positions with enabled Compound collateral and borrow positions. For collateral 
     * assets, update cToken default position. For borrow assets, update external borrow position.
     * - Collateral assets may come out of sync when a position is liquidated
     * - Borrow assets may come out of sync when interest is accrued or position is liquidated and borrow is repaid
     *
     * @param _setToken             Instance of the SetToken
     */
    function sync(ISetToken _setToken) public nonReentrant onlyValidAndInitializedSet(_setToken) {
        uint256 setTotalSupply = _setToken.totalSupply();

        // Only sync positions when Set supply is not 0. This preserves debt and collateral positions on issuance / redemption
        // and does not 
        if (setTotalSupply > 0) {
            // Loop through collateral assets
            for(uint256 i = 0; i < enabledAssets[_setToken].collateralCTokens.length; i++) {
                address collateralCToken = enabledAssets[_setToken].collateralCTokens[i];
                uint256 previousPositionUnit = _setToken.getDefaultPositionRealUnit(collateralCToken).toUint256();
                uint256 newPositionUnit = _getCollateralPosition(_setToken, collateralCToken, setTotalSupply);

                // Note: Accounts for if position does not exist on SetToken but is tracked in enabledAssets
                if (previousPositionUnit != newPositionUnit) {
                  _updateCollateralPosition(_setToken, collateralCToken, newPositionUnit);
                }
            }

            // Loop through borrow assets
            for(uint256 i = 0; i < enabledAssets[_setToken].borrowCTokens.length; i++) {
                address borrowCToken = enabledAssets[_setToken].borrowCTokens[i];
                address borrowAsset = enabledAssets[_setToken].borrowAssets[i];

                int256 previousPositionUnit = _setToken.getExternalPositionRealUnit(borrowAsset, address(this));

                int256 newPositionUnit = _getBorrowPosition(
                    _setToken,
                    borrowCToken,
                    setTotalSupply
                );

                // Note: Accounts for if position does not exist on SetToken but is tracked in enabledAssets
                if (newPositionUnit != previousPositionUnit) {
                    _updateBorrowPosition(_setToken, borrowAsset, newPositionUnit);
                }
            }
        }
        emit PositionsSynced(_setToken, msg.sender);
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
        address[] memory _collateralAssets,
        address[] memory _borrowAssets
    )
        external
        onlySetManager(_setToken, msg.sender)
        onlyValidAndPendingSet(_setToken)
    {
        if (!anySetInitializable) {
            require(allowList[_setToken], "Not allowlisted");
        }

        // Initialize module before trying register
        _setToken.initializeModule();

        // Get debt issuance module registered to this module and require that it is initialized
        require(_setToken.isInitializedModule(getAndValidateAdapter(DEFAULT_ISSUANCE_MODULE_NAME)), "Issuance not initialized");

        // Try if register exists on any of the modules including the debt issuance module
        address[] memory modules = _setToken.getModules();
        for(uint256 i = 0; i < modules.length; i++) {
            try IDebtIssuanceModule(modules[i]).register(_setToken) {} catch {}
        }
        
        // Enable collateral and borrow assets on Compound
        addCollateralAssets(_setToken, _collateralAssets);

        addBorrowAssets(_setToken, _borrowAssets);
    }

    /**
     * MANAGER ONLY: Removes this module from the SetToken, via call by the SetToken. Compound Settings and manager enabled
     * cTokens are deleted. Markets are exited on Comptroller (only valid if borrow balances are zero)
     */
    function removeModule() external override {
        ISetToken setToken = ISetToken(msg.sender);

        // Sync Compound and SetToken positions prior to any removal action
        sync(setToken);

        for (uint256 i = 0; i < enabledAssets[setToken].borrowCTokens.length; i++) {
            address cToken = enabledAssets[setToken].borrowCTokens[i];

            // Note: if there is an existing borrow balance, will revert and market cannot be exited on Compound
            _exitMarket(setToken, cToken);

            delete isBorrowCTokenEnabled[setToken][cToken];
        }

        for (uint256 i = 0; i < enabledAssets[setToken].collateralCTokens.length; i++) {
            address cToken = enabledAssets[setToken].collateralCTokens[i];

            _exitMarket(setToken, cToken);

            delete isCollateralCTokenEnabled[setToken][cToken];
        }
        
        delete enabledAssets[setToken];

        // Try if unregister exists on any of the modules
        address[] memory modules = setToken.getModules();
        for(uint256 i = 0; i < modules.length; i++) {
            try IDebtIssuanceModule(modules[i]).unregister(setToken) {} catch {}
        }
    }

    /**
     * MANAGER ONLY: Add registration of this module on debt issuance module for the SetToken. Note: if the debt issuance module is not added to SetToken
     * before this module is initialized, then this function needs to be called if the debt issuance module is later added and initialized to prevent state
     * inconsistencies
     *
     * @param _setToken             Instance of the SetToken
     * @param _debtIssuanceModule   Debt issuance module address to register
     */
    function registerToModule(ISetToken _setToken, address _debtIssuanceModule) external onlyManagerAndValidSet(_setToken) {
        require(_setToken.isInitializedModule(_debtIssuanceModule), "Issuance not initialized");

        IDebtIssuanceModule(_debtIssuanceModule).register(_setToken);
    }

    /**
     * MANAGER ONLY: Add enabled collateral assets. Collateral assets are tracked for syncing positions and entered in Compound markets
     *
     * @param _setToken             Instance of the SetToken
     * @param _newCollateralAssets  Addresses of new collateral underlying assets
     */
    function addCollateralAssets(ISetToken _setToken, address[] memory _newCollateralAssets) public onlyManagerAndValidSet(_setToken) {
        for(uint256 i = 0; i < _newCollateralAssets.length; i++) {
            address cToken = underlyingToCToken[_newCollateralAssets[i]];
            require(cToken != address(0), "cToken must exist");
            require(!isCollateralCTokenEnabled[_setToken][cToken], "Collateral enabled");

            // Note: Will only enter market if cToken is not enabled as a borrow asset as well
            if (!isBorrowCTokenEnabled[_setToken][cToken]) {
                _enterMarket(_setToken, cToken);
            }

            isCollateralCTokenEnabled[_setToken][cToken] = true;
            enabledAssets[_setToken].collateralCTokens.push(cToken);
        }

        emit CollateralAssetsAdded(_setToken, _newCollateralAssets);
    }

    /**
     * MANAGER ONLY: Remove collateral asset. Collateral asset exited in Compound markets
     * If there is a borrow balance, collateral asset cannot be removed
     *
     * @param _setToken             Instance of the SetToken
     * @param _collateralAssets     Addresses of collateral underlying assets to remove
     */
    function removeCollateralAssets(ISetToken _setToken, address[] memory _collateralAssets) external onlyManagerAndValidSet(_setToken) {
        // Sync Compound and SetToken positions prior to any removal action
        sync(_setToken);

        for(uint256 i = 0; i < _collateralAssets.length; i++) {
            address cToken = underlyingToCToken[_collateralAssets[i]];
            require(isCollateralCTokenEnabled[_setToken][cToken], "Collateral not enabled");
            
            // Note: Will only exit market if cToken is not enabled as a borrow asset as well
            // If there is an existing borrow balance, will revert and market cannot be exited on Compound
            if (!isBorrowCTokenEnabled[_setToken][cToken]) {
                _exitMarket(_setToken, cToken);
            }

            delete isCollateralCTokenEnabled[_setToken][cToken];
            enabledAssets[_setToken].collateralCTokens = enabledAssets[_setToken].collateralCTokens.remove(cToken);
        }

        emit CollateralAssetsRemoved(_setToken, _collateralAssets);
    }

    /**
     * MANAGER ONLY: Add borrow asset. Borrow asset is tracked for syncing positions and entered in Compound markets
     *
     * @param _setToken             Instance of the SetToken
     * @param _newBorrowAssets      Addresses of borrow underlying assets to add
     */
    function addBorrowAssets(ISetToken _setToken, address[] memory _newBorrowAssets) public onlyManagerAndValidSet(_setToken) {
        for(uint256 i = 0; i < _newBorrowAssets.length; i++) {
            address cToken = underlyingToCToken[_newBorrowAssets[i]];
            require(cToken != address(0), "cToken must exist");
            require(!isBorrowCTokenEnabled[_setToken][cToken], "Borrow enabled");

            // Note: Will only enter market if cToken is not enabled as a borrow asset as well
            if (!isCollateralCTokenEnabled[_setToken][cToken]) {
                _enterMarket(_setToken, cToken);
            }

            isBorrowCTokenEnabled[_setToken][cToken] = true;
            enabledAssets[_setToken].borrowCTokens.push(cToken);
            enabledAssets[_setToken].borrowAssets.push(_newBorrowAssets[i]);
        }

        emit BorrowAssetsAdded(_setToken, _newBorrowAssets);
    }

    /**
     * MANAGER ONLY: Remove borrow asset. Borrow asset is exited in Compound markets
     * If there is a borrow balance, borrow asset cannot be removed
     *
     * @param _setToken             Instance of the SetToken
     * @param _borrowAssets         Addresses of borrow underlying assets to remove
     */
    function removeBorrowAssets(ISetToken _setToken, address[] memory _borrowAssets) external onlyManagerAndValidSet(_setToken) {
        // Sync Compound and SetToken positions prior to any removal action
        sync(_setToken);

        for(uint256 i = 0; i < _borrowAssets.length; i++) {
            address cToken = underlyingToCToken[_borrowAssets[i]];
            require(isBorrowCTokenEnabled[_setToken][cToken], "Borrow not enabled");
            
            // Note: Will only exit market if cToken is not enabled as a collateral asset as well
            // If there is an existing borrow balance, will revert and market cannot be exited on Compound
            if (!isCollateralCTokenEnabled[_setToken][cToken]) {
                _exitMarket(_setToken, cToken);
            }

            delete isBorrowCTokenEnabled[_setToken][cToken];
            enabledAssets[_setToken].borrowCTokens = enabledAssets[_setToken].borrowCTokens.remove(cToken);
            enabledAssets[_setToken].borrowAssets = enabledAssets[_setToken].borrowAssets.remove(_borrowAssets[i]);
        }

        emit BorrowAssetsRemoved(_setToken, _borrowAssets);
    }

    /**
     * GOVERNANCE ONLY: Add allowed SetToken to initialize this module. Only callable by governance.
     *
     * @param _setToken             Instance of the SetToken
     */
    function addAllowedSetToken(ISetToken _setToken) external onlyOwner {
        allowList[_setToken] = true;
    }

    /**
     * GOVERNANCE ONLY: Remove SetToken allowed to initialize this module. Only callable by governance.
     *
     * @param _setToken             Instance of the SetToken
     */
    function removeAllowedSetToken(ISetToken _setToken) external onlyOwner {
        allowList[_setToken] = false;
    }

    /**
     * GOVERNANCE ONLY: Toggle whether any SetToken is allowed to initialize this module. Only callable by governance.
     *
     * @param _anySetInitializable             Bool indicating whether allowlist is enabled
     */
    function updateAnySetInitializable(bool _anySetInitializable) external onlyOwner {
        anySetInitializable = _anySetInitializable;
    }

    /**
     * GOVERNANCE ONLY: Add Compound market to module with stored underlying to cToken mapping in case of market additions to Compound.
     *
     * IMPORTANT: Validations are skipped in order to get contract under bytecode limit 
     *
     * @param _cToken                   Address of cToken to add
     * @param _underlying               Address of underlying token that maps to cToken
     */
    function addCompoundMarket(address _cToken, address _underlying) external onlyOwner {
        underlyingToCToken[_underlying] = _cToken;
    }

    /**
     * GOVERNANCE ONLY: Remove Compound market on stored underlying to cToken mapping in case of market removals
     *
     * IMPORTANT: Validations are skipped in order to get contract under bytecode limit 
     *
     * @param _underlying               Address of underlying token to remove
     */
    function removeCompoundMarket(address _underlying) external onlyOwner {
        delete underlyingToCToken[_underlying];
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
     * MODULE ONLY: Hook called prior to redemption to sync positions on SetToken. Only callable by valid module.
     *
     * @param _setToken             Instance of the SetToken
     */
    function moduleRedeemHook(ISetToken _setToken, uint256 /* _setTokenQuantity */) external onlyModule(_setToken) {
        sync(_setToken);
    }

    /**
     * MODULE ONLY: Hook called prior to looping through each component on issuance. Invokes borrow in order for module to return debt to issuer. Only callable by valid module.
     *
     * @param _setToken             Instance of the SetToken
     * @param _setTokenQuantity     Quantity of SetToken
     * @param _component            Address of component
     */
    function componentIssueHook(ISetToken _setToken, uint256 _setTokenQuantity, address _component) external onlyModule(_setToken) {
        int256 componentDebt = _setToken.getExternalPositionRealUnit(_component, address(this));
        uint256 notionalDebt = componentDebt.mul(-1).toUint256().preciseMul(_setTokenQuantity);

        _borrow(_setToken, underlyingToCToken[_component], notionalDebt);
    }

    /**
     * MODULE ONLY: Hook called prior to looping through each component on redemption. Invokes repay after issuance module transfers debt from issuer. Only callable by valid module.
     *
     * @param _setToken             Instance of the SetToken
     * @param _setTokenQuantity     Quantity of SetToken
     * @param _component            Address of component
     */
    function componentRedeemHook(ISetToken _setToken, uint256 _setTokenQuantity, address _component) external onlyModule(_setToken) {
        int256 componentDebt = _setToken.getExternalPositionRealUnit(_component, address(this));
        uint256 notionalDebt = componentDebt.mul(-1).toUint256().preciseMulCeil(_setTokenQuantity);

        _repayBorrow(_setToken, underlyingToCToken[_component], _component, notionalDebt);
    }


    /* ============ External Getter Functions ============ */

    /**
     * Get enabled assets for SetToken. Returns an array of enabled cTokens that are collateral assets and an
     * array of underlying that are borrow assets.
     *
     * @return                    Collateral cToken assets that are enabled
     * @return                    Underlying borrowed assets that are enabled.
     */
    function getEnabledAssets(ISetToken _setToken) external view returns(address[] memory, address[] memory) {
        return (
            enabledAssets[_setToken].collateralCTokens,
            enabledAssets[_setToken].borrowAssets
        );
    }

    /* ============ Internal Functions ============ */

    /**
     * Invoke enter markets from SetToken
     */
    function _enterMarket(ISetToken _setToken, address _cToken) internal {
        address[] memory marketsToEnter = new address[](1);
        marketsToEnter[0] = _cToken;

        // Compound's enter market function signature is: enterMarkets(address[] _cTokens)
        uint256[] memory returnValues = abi.decode(
            _setToken.invoke(address(comptroller), 0, abi.encodeWithSignature("enterMarkets(address[])", marketsToEnter)),
            (uint256[])
        );
        require(returnValues[0] == 0, "Entering failed");
    }

    /**
     * Invoke exit market from SetToken
     */
    function _exitMarket(ISetToken _setToken, address _cToken) internal {
        // Compound's exit market function signature is: exitMarket(address _cToken)
        require(
            abi.decode(
                _setToken.invoke(address(comptroller), 0, abi.encodeWithSignature("exitMarket(address)", _cToken)),
                (uint256)
            ) == 0,
            "Exiting failed"
        );
    }

    /**
     * Mints the specified cToken from the underlying of the specified notional quantity. If cEther, the WETH must be 
     * unwrapped as it only accepts the underlying ETH.
     */
    function _mintCToken(ISetToken _setToken, address _cToken, address _underlyingToken, uint256 _mintNotional) internal {
        if (_cToken == cEther) {
            _setToken.invokeUnwrapWETH(weth, _mintNotional);

            // Compound's mint cEther function signature is: mint(). No return, reverts on error.
            _setToken.invoke(_cToken, _mintNotional, abi.encodeWithSignature("mint()"));
        } else {
            _setToken.invokeApprove(_underlyingToken, _cToken, _mintNotional);

            // Compound's mint cToken function signature is: mint(uint256 _mintAmount). Returns 0 if success
            require(
                abi.decode(
                    _setToken.invoke(_cToken, 0, abi.encodeWithSignature("mint(uint256)", _mintNotional)),
                    (uint256)
                ) == 0,
                "Mint failed"
            );
        }
    }

    /**
     * Invoke redeem from SetToken. If cEther, then also wrap ETH into WETH.
     */
    function _redeemUnderlying(ISetToken _setToken, address _cToken, uint256 _redeemNotional) internal {
        // Compound's redeem function signature is: redeemUnderlying(uint256 _underlyingAmount)
        require(
            abi.decode(
                _setToken.invoke(_cToken, 0, abi.encodeWithSignature("redeemUnderlying(uint256)", _redeemNotional)),
                (uint256)
            ) == 0,
            "Redeem failed"
        );

        if (_cToken == cEther) {
            _setToken.invokeWrapWETH(weth, _redeemNotional);
        }
    }

    /**
     * Invoke repay from SetToken. If cEther then unwrap WETH into ETH.
     */
    function _repayBorrow(ISetToken _setToken, address _cToken, address _underlyingToken, uint256 _repayNotional) internal {
        if (_cToken == cEther) {
            _setToken.invokeUnwrapWETH(weth, _repayNotional);

            // Compound's repay ETH function signature is: repayBorrow(). No return, revert on fail
            _setToken.invoke(_cToken, _repayNotional, abi.encodeWithSignature("repayBorrow()"));
        } else {
            // Approve to cToken
            _setToken.invokeApprove(_underlyingToken, _cToken, _repayNotional);
            // Compound's repay asset function signature is: repayBorrow(uint256 _repayAmount)
            require(
                abi.decode(
                    _setToken.invoke(_cToken, 0, abi.encodeWithSignature("repayBorrow(uint256)", _repayNotional)),
                    (uint256)
                ) == 0,
                "Repay failed"
            );
        }
    }

    /**
     * Invoke the SetToken to interact with the specified cToken to borrow the cToken's underlying of the specified borrowQuantity.
     */
    function _borrow(ISetToken _setToken, address _cToken, uint256 _notionalBorrowQuantity) internal {
        // Compound's borrow function signature is: borrow(uint256 _borrowAmount). Note: Notional borrow quantity is in units of underlying asset
        require(
            abi.decode(
                _setToken.invoke(_cToken, 0, abi.encodeWithSignature("borrow(uint256)", _notionalBorrowQuantity)),
                (uint256)
            ) == 0,
            "Borrow failed"
        );
        if (_cToken == cEther) {
            _setToken.invokeWrapWETH(weth, _notionalBorrowQuantity);
        }
    }

    /**
     * Executes a trade, validates the minimum receive quantity is returned, and pays protocol fee (if applicable)
     */
    function _tradeAndHandleFees(
        ISetToken _setToken,
        address _sendToken,
        address _receiveToken,
        uint256 _notionalSendQuantity,
        uint256 _minNotionalReceiveQuantity,
        uint256 _preTradeReceiveTokenBalance,
        IExchangeAdapter _exchangeAdapter,
        bytes memory _data
    )
        internal
        returns(uint256, uint256)
    {
        _executeTrade(
            _setToken,
            _sendToken,
            _receiveToken,
            _notionalSendQuantity,
            _minNotionalReceiveQuantity,
            _exchangeAdapter,
            _data
        );

        uint256 receiveTokenQuantity = IERC20(_receiveToken).balanceOf(address(_setToken)).sub(_preTradeReceiveTokenBalance);
        require(
            receiveTokenQuantity >= _minNotionalReceiveQuantity,
            "Slippage too high"
        );

        uint256 protocolFeeTotal = _accrueProtocolFee(_setToken, _receiveToken, receiveTokenQuantity);

        return (protocolFeeTotal, receiveTokenQuantity.sub(protocolFeeTotal));
    }

    /**
     * Invokes approvals, gets trade call data from exchange adapter and invokes trade from SetToken
     */
    function _executeTrade(
        ISetToken _setToken,
        address _sendToken,
        address _receiveToken,
        uint256 _notionalSendQuantity,
        uint256 _minNotionalReceiveQuantity,
        IExchangeAdapter _exchangeAdapter,
        bytes memory _data
    )
        internal
    {
         _setToken.invokeApprove(
            _sendToken,
            _exchangeAdapter.getSpender(),
            _notionalSendQuantity
        );

        (
            address targetExchange,
            uint256 callValue,
            bytes memory methodData
        ) = _exchangeAdapter.getTradeCalldata(
            _sendToken,
            _receiveToken,
            address(_setToken),
            _notionalSendQuantity,
            _minNotionalReceiveQuantity,
            _data
        );

        _setToken.invoke(targetExchange, callValue, methodData);
    }

    /**
     * Calculates protocol fee on module land pays protocol fee from SetToken
     */
    function _accrueProtocolFee(ISetToken _setToken, address _receiveToken, uint256 _exchangedQuantity) internal returns(uint256) {
        uint256 protocolFeeTotal = getModuleFee(PROTOCOL_TRADE_FEE_INDEX, _exchangedQuantity);
        
        payProtocolFeeFromSetToken(_setToken, _receiveToken, protocolFeeTotal);

        return protocolFeeTotal;
    }

    function _updateCollateralPosition(ISetToken _setToken, address _cToken, uint256 _newPositionUnit) internal {
        _setToken.editDefaultPosition(_cToken, _newPositionUnit);
    }

    function _updateBorrowPosition(ISetToken _setToken, address _underlyingToken, int256 _newPositionUnit) internal {
        _setToken.editExternalPosition(_underlyingToken, address(this), _newPositionUnit, "");
    }

    /**
     * Construct the ActionInfo struct for lever and delever
     */
    function _createActionInfo(
        ISetToken _setToken,
        address _sendToken,
        address _receiveToken,
        uint256 _sendQuantity,
        uint256 _minReceiveQuantity,
        string memory _tradeAdapterName,
        bool isLever
    )
        internal
        view
        returns(ActionInfo memory)
    {
        ActionInfo memory actionInfo;

        actionInfo.exchangeAdapter = IExchangeAdapter(getAndValidateAdapter(_tradeAdapterName));
        actionInfo.setToken = _setToken;
        actionInfo.collateralCTokenAsset = isLever ? underlyingToCToken[_receiveToken] : underlyingToCToken[_sendToken];
        actionInfo.borrowCTokenAsset = isLever ? underlyingToCToken[_sendToken] : underlyingToCToken[_receiveToken];
        actionInfo.setTotalSupply = _setToken.totalSupply();
        actionInfo.notionalSendQuantity = _sendQuantity.preciseMul(actionInfo.setTotalSupply);
        actionInfo.minNotionalReceiveQuantity = _minReceiveQuantity.preciseMul(actionInfo.setTotalSupply);
        // Snapshot pre trade receive token balance.
        actionInfo.preTradeReceiveTokenBalance = IERC20(_receiveToken).balanceOf(address(_setToken));

        return actionInfo;
    }

    /**
     * Construct the ActionInfo struct for gulp and validate gulp info.
     */
    function _createGulpInfoAndValidate(
        ISetToken _setToken,
        address _collateralAsset,
        string memory _tradeAdapterName
    )
        internal
        view
        returns(ActionInfo memory)
    {
        ActionInfo memory actionInfo;
        actionInfo.collateralCTokenAsset = underlyingToCToken[_collateralAsset];
        // Validate collateral is enabled
        require(isCollateralCTokenEnabled[_setToken][actionInfo.collateralCTokenAsset], "Collateral is not enabled");

        actionInfo.exchangeAdapter = IExchangeAdapter(getAndValidateAdapter(_tradeAdapterName));
        actionInfo.setTotalSupply = _setToken.totalSupply();
        // Snapshot pre trade receive token balance.
        actionInfo.preTradeReceiveTokenBalance = IERC20(_collateralAsset).balanceOf(address(_setToken));
        
        // Calculate notional send quantity by comparing balance of COMP after claiming against the total notional units
        // of COMP tracked on the SetToken
        uint256 defaultCompPositionNotional = _setToken
            .getDefaultPositionRealUnit(compToken)
            .toUint256()
            .preciseMul(actionInfo.setTotalSupply);

        actionInfo.notionalSendQuantity = IERC20(compToken).balanceOf(address(_setToken)).sub(defaultCompPositionNotional);
        require(actionInfo.notionalSendQuantity > 0, "Claim is 0");

        return actionInfo;
    }

    function _validateCommon(ActionInfo memory _actionInfo) internal view {
        require(isCollateralCTokenEnabled[_actionInfo.setToken][_actionInfo.collateralCTokenAsset], "Collateral not enabled");
        require(isBorrowCTokenEnabled[_actionInfo.setToken][_actionInfo.borrowCTokenAsset], "Borrow not enabled");
        require(_actionInfo.collateralCTokenAsset != _actionInfo.borrowCTokenAsset, "Must be different");
        require(_actionInfo.notionalSendQuantity > 0, "Quantity is 0");
    }

    function _getCollateralPosition(ISetToken _setToken, address _cToken, uint256 _setTotalSupply) internal view returns (uint256) {
        uint256 collateralNotionalBalance = IERC20(_cToken).balanceOf(address(_setToken));
        return collateralNotionalBalance.preciseDiv(_setTotalSupply);
    }

    function _getBorrowPosition(ISetToken _setToken, address _cToken, uint256 _setTotalSupply) internal returns (int256) {
        uint256 borrowNotionalBalance = ICErc20(_cToken).borrowBalanceCurrent(address(_setToken));
        // Round negative away from 0
        return borrowNotionalBalance.preciseDivCeil(_setTotalSupply).toInt256().mul(-1);
    }
}