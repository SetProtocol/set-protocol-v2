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
        ICErc20 collateralCTokenAsset;           // Address of cToken collateral asset
        ICErc20 borrowCTokenAsset;               // Address of cToken borrow asset
        uint256 preTradeReceiveTokenBalance;     // Balance of pre-trade receive token balance
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

    event COMPGulped(
        ISetToken indexed _setToken,
        IERC20 indexed _collateralAsset,
        IExchangeAdapter _exchangeAdapter,
        uint256 _totalCompClaimed,
        uint256 _totalReceiveAmount,
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

    event SetTokenStatusUpdated(
        ISetToken indexed _setToken,
        bool indexed _added
    );

    event AnySetAllowedUpdated(
        bool indexed _anySetAllowed    
    );

    /* ============ Constants ============ */

    // String identifying the DebtIssuanceModule in the IntegrationRegistry. Note: Governance must add DefaultIssuanceModule as
    // the string as the integration name
    string constant internal DEFAULT_ISSUANCE_MODULE_NAME = "DefaultIssuanceModule";

    // 0 index stores protocol fee % on the controller, charged in the trade function
    uint256 constant internal PROTOCOL_TRADE_FEE_INDEX = 0;

    /* ============ State Variables ============ */

    // Mapping of underlying to CToken. If ETH, then map WETH to cETH
    mapping(IERC20 => ICErc20) public underlyingToCToken;

    // Wrapped Ether address
    IERC20 internal weth;

    // Compound cEther address
    ICErc20 internal cEther;

    // Compound Comptroller contract
    IComptroller internal comptroller;

    // COMP token address
    IERC20 internal compToken;

    // Mapping to efficiently check if cToken market for collateral asset is valid in SetToken
    mapping(ISetToken => mapping(ICErc20 => bool)) public collateralCTokenEnabled;

    // Mapping to efficiently check if cToken market for borrow asset is valid in SetToken
    mapping(ISetToken => mapping(ICErc20 => bool)) public borrowCTokenEnabled;

    // Mapping of enabled collateral and borrow cTokens for syncing positions
    mapping(ISetToken => EnabledAssets) internal enabledAssets;

    // Mapping of SetToken to boolean indicating if SetToken is on allow list. Updateable by governance
    mapping(ISetToken => bool) public allowedSetTokens;

    // Boolean that returns if any SetToken can initialize this module. If false, then subject to allow list
    bool public anySetAllowed;


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
        IERC20 _compToken,
        IComptroller _comptroller,
        ICErc20 _cEther,
        IERC20 _weth
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
            ICErc20 cToken = cTokens[i];
            underlyingToCToken[
                cToken == _cEther ? _weth : IERC20(cTokens[i].underlying())
            ] = cToken;
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
        IERC20 _collateralAsset,
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

        emit COMPGulped(
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
            address[] memory collateralCTokens = enabledAssets[_setToken].collateralCTokens;
            for(uint256 i = 0; i < collateralCTokens.length; i++) {
                ICErc20 collateralCToken = ICErc20(collateralCTokens[i]);
                uint256 previousPositionUnit = _setToken.getDefaultPositionRealUnit(address(collateralCToken)).toUint256();
                uint256 newPositionUnit = _getCollateralPosition(_setToken, collateralCToken, setTotalSupply);

                // Note: Accounts for if position does not exist on SetToken but is tracked in enabledAssets
                if (previousPositionUnit != newPositionUnit) {
                  _updateCollateralPosition(_setToken, collateralCToken, newPositionUnit);
                }
            }

            // Loop through borrow assets
            address[] memory borrowCTokens = enabledAssets[_setToken].borrowCTokens;
            address[] memory borrowAssets = enabledAssets[_setToken].borrowAssets;
            for(uint256 i = 0; i < borrowCTokens.length; i++) {
                ICErc20 borrowCToken = ICErc20(borrowCTokens[i]);
                IERC20 borrowAsset = IERC20(borrowAssets[i]);

                int256 previousPositionUnit = _setToken.getExternalPositionRealUnit(address(borrowAsset), address(this));

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
        
        // Enable collateral and borrow assets on Compound
        addCollateralAssets(_setToken, _collateralAssets);

        addBorrowAssets(_setToken, _borrowAssets);
    }

    /**
     * MANAGER ONLY: Removes this module from the SetToken, via call by the SetToken. Compound Settings and manager enabled
     * cTokens are deleted. Markets are exited on Comptroller (only valid if borrow balances are zero)
     */
    function removeModule() external override onlyValidAndInitializedSet(ISetToken(msg.sender)) {
        ISetToken setToken = ISetToken(msg.sender);

        // Sync Compound and SetToken positions prior to any removal action
        sync(setToken);

        address[] memory borrowCTokens = enabledAssets[setToken].borrowCTokens;
        for (uint256 i = 0; i < borrowCTokens.length; i++) {
            ICErc20 cToken = ICErc20(borrowCTokens[i]);

            // Will exit only if token isn't also being used as collateral
            if(!collateralCTokenEnabled[setToken][cToken]) {
                // Note: if there is an existing borrow balance, will revert and market cannot be exited on Compound
                _exitMarket(setToken, cToken);
            }

            delete borrowCTokenEnabled[setToken][cToken];
        }

        address[] memory collateralCTokens = enabledAssets[setToken].collateralCTokens;
        for (uint256 i = 0; i < collateralCTokens.length; i++) {
            ICErc20 cToken = ICErc20(collateralCTokens[i]);

            _exitMarket(setToken, cToken);

            delete collateralCTokenEnabled[setToken][cToken];
        }
        
        delete enabledAssets[setToken];

        // Try if unregister exists on any of the modules
        address[] memory modules = setToken.getModules();
        for(uint256 i = 0; i < modules.length; i++) {
            try IDebtIssuanceModule(modules[i]).unregisterFromIssuanceModule(setToken) {} catch {}
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
    function registerToModule(ISetToken _setToken, IDebtIssuanceModule _debtIssuanceModule) external onlyManagerAndValidSet(_setToken) {
        require(_setToken.isInitializedModule(address(_debtIssuanceModule)), "Issuance not initialized");

        _debtIssuanceModule.registerToIssuanceModule(_setToken);
    }

    /**
     * MANAGER ONLY: Add enabled collateral assets. Collateral assets are tracked for syncing positions and entered in Compound markets
     *
     * @param _setToken             Instance of the SetToken
     * @param _newCollateralAssets  Addresses of new collateral underlying assets
     */
    function addCollateralAssets(ISetToken _setToken, IERC20[] memory _newCollateralAssets) public onlyManagerAndValidSet(_setToken) {
        for(uint256 i = 0; i < _newCollateralAssets.length; i++) {
            ICErc20 cToken = underlyingToCToken[_newCollateralAssets[i]];
            require(address(cToken) != address(0), "cToken must exist");
            require(!collateralCTokenEnabled[_setToken][cToken], "Collateral enabled");

            // Note: Will only enter market if cToken is not enabled as a borrow asset as well
            if (!borrowCTokenEnabled[_setToken][cToken]) {
                _enterMarket(_setToken, cToken);
            }

            collateralCTokenEnabled[_setToken][cToken] = true;
            enabledAssets[_setToken].collateralCTokens.push(address(cToken));
        }

        emit CollateralAssetsUpdated(_setToken, true, _newCollateralAssets);
    }

    /**
     * MANAGER ONLY: Remove collateral asset. Collateral asset exited in Compound markets
     * If there is a borrow balance, collateral asset cannot be removed
     *
     * @param _setToken             Instance of the SetToken
     * @param _collateralAssets     Addresses of collateral underlying assets to remove
     */
    function removeCollateralAssets(ISetToken _setToken, IERC20[] memory _collateralAssets) external onlyManagerAndValidSet(_setToken) {
        // Sync Compound and SetToken positions prior to any removal action
        sync(_setToken);

        for(uint256 i = 0; i < _collateralAssets.length; i++) {
            ICErc20 cToken = underlyingToCToken[_collateralAssets[i]];
            require(collateralCTokenEnabled[_setToken][cToken], "Collateral not enabled");
            
            // Note: Will only exit market if cToken is not enabled as a borrow asset as well
            // If there is an existing borrow balance, will revert and market cannot be exited on Compound
            if (!borrowCTokenEnabled[_setToken][cToken]) {
                _exitMarket(_setToken, cToken);
            }

            delete collateralCTokenEnabled[_setToken][cToken];
            enabledAssets[_setToken].collateralCTokens.removeStorage(address(cToken));
        }

        emit CollateralAssetsUpdated(_setToken, false, _collateralAssets);
    }

    /**
     * MANAGER ONLY: Add borrow asset. Borrow asset is tracked for syncing positions and entered in Compound markets
     *
     * @param _setToken             Instance of the SetToken
     * @param _newBorrowAssets      Addresses of borrow underlying assets to add
     */
    function addBorrowAssets(ISetToken _setToken, IERC20[] memory _newBorrowAssets) public onlyManagerAndValidSet(_setToken) {
        for(uint256 i = 0; i < _newBorrowAssets.length; i++) {
            IERC20 newBorrowAsset = _newBorrowAssets[i];
            ICErc20 cToken = underlyingToCToken[newBorrowAsset];
            require(address(cToken) != address(0), "cToken must exist");
            require(!borrowCTokenEnabled[_setToken][cToken], "Borrow enabled");

            // Note: Will only enter market if cToken is not enabled as a borrow asset as well
            if (!collateralCTokenEnabled[_setToken][cToken]) {
                _enterMarket(_setToken, cToken);
            }

            borrowCTokenEnabled[_setToken][cToken] = true;
            enabledAssets[_setToken].borrowCTokens.push(address(cToken));
            enabledAssets[_setToken].borrowAssets.push(address(newBorrowAsset));
        }

        emit BorrowAssetsUpdated(_setToken, true, _newBorrowAssets);
    }

    /**
     * MANAGER ONLY: Remove borrow asset. Borrow asset is exited in Compound markets
     * If there is a borrow balance, borrow asset cannot be removed
     *
     * @param _setToken             Instance of the SetToken
     * @param _borrowAssets         Addresses of borrow underlying assets to remove
     */
    function removeBorrowAssets(ISetToken _setToken, IERC20[] memory _borrowAssets) external onlyManagerAndValidSet(_setToken) {
        // Sync Compound and SetToken positions prior to any removal action
        sync(_setToken);

        for(uint256 i = 0; i < _borrowAssets.length; i++) {
            ICErc20 cToken = underlyingToCToken[_borrowAssets[i]];
            require(borrowCTokenEnabled[_setToken][cToken], "Borrow not enabled");
            
            // Note: Will only exit market if cToken is not enabled as a collateral asset as well
            // If there is an existing borrow balance, will revert and market cannot be exited on Compound
            if (!collateralCTokenEnabled[_setToken][cToken]) {
                _exitMarket(_setToken, cToken);
            }

            delete borrowCTokenEnabled[_setToken][cToken];
            enabledAssets[_setToken].borrowCTokens.removeStorage(address(cToken));
            enabledAssets[_setToken].borrowAssets.removeStorage(address(_borrowAssets[i]));
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
     * GOVERNANCE ONLY: Add Compound market to module with stored underlying to cToken mapping in case of market additions to Compound.
     *
     * IMPORTANT: Validations are skipped in order to get contract under bytecode limit 
     *
     * @param _cToken                   Address of cToken to add
     * @param _underlying               Address of underlying token that maps to cToken
     */
    function addCompoundMarket(ICErc20 _cToken, IERC20 _underlying) external onlyOwner {
        require(address(underlyingToCToken[_underlying]) == address(0), "Already added");
        underlyingToCToken[_underlying] = _cToken;
    }

    /**
     * GOVERNANCE ONLY: Remove Compound market on stored underlying to cToken mapping in case of market removals
     *
     * IMPORTANT: Validations are skipped in order to get contract under bytecode limit 
     *
     * @param _underlying               Address of underlying token to remove
     */
    function removeCompoundMarket(IERC20 _underlying) external onlyOwner {
        require(address(underlyingToCToken[_underlying]) != address(0), "Not added");
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
    function componentIssueHook(ISetToken _setToken, uint256 _setTokenQuantity, IERC20 _component, bool /* _isEquity */) external onlyModule(_setToken) {
        int256 componentDebt = _setToken.getExternalPositionRealUnit(address(_component), address(this));

        require(componentDebt < 0, "Component must be negative");

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
    function componentRedeemHook(ISetToken _setToken, uint256 _setTokenQuantity, IERC20 _component, bool /* _isEquity */) external onlyModule(_setToken) {
        int256 componentDebt = _setToken.getExternalPositionRealUnit(address(_component), address(this));

        require(componentDebt < 0, "Component must be negative");

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
    function _enterMarket(ISetToken _setToken, ICErc20 _cToken) internal {
        address[] memory marketsToEnter = new address[](1);
        marketsToEnter[0] = address(_cToken);

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
    function _exitMarket(ISetToken _setToken, ICErc20 _cToken) internal {
        // Compound's exit market function signature is: exitMarket(address _cToken)
        require(
            abi.decode(
                _setToken.invoke(address(comptroller), 0, abi.encodeWithSignature("exitMarket(address)", address(_cToken))),
                (uint256)
            ) == 0,
            "Exiting failed"
        );
    }

    /**
     * Mints the specified cToken from the underlying of the specified notional quantity. If cEther, the WETH must be 
     * unwrapped as it only accepts the underlying ETH.
     */
    function _mintCToken(ISetToken _setToken, ICErc20 _cToken, IERC20 _underlyingToken, uint256 _mintNotional) internal {
        if (_cToken == cEther) {
            _setToken.invokeUnwrapWETH(address(weth), _mintNotional);

            // Compound's mint cEther function signature is: mint(). No return, reverts on error.
            _setToken.invoke(address(_cToken), _mintNotional, abi.encodeWithSignature("mint()"));
        } else {
            _setToken.invokeApprove(address(_underlyingToken), address(_cToken), _mintNotional);

            // Compound's mint cToken function signature is: mint(uint256 _mintAmount). Returns 0 if success
            require(
                abi.decode(
                    _setToken.invoke(address(_cToken), 0, abi.encodeWithSignature("mint(uint256)", _mintNotional)),
                    (uint256)
                ) == 0,
                "Mint failed"
            );
        }
    }

    /**
     * Invoke redeem from SetToken. If cEther, then also wrap ETH into WETH.
     */
    function _redeemUnderlying(ISetToken _setToken, ICErc20 _cToken, uint256 _redeemNotional) internal {
        // Compound's redeem function signature is: redeemUnderlying(uint256 _underlyingAmount)
        require(
            abi.decode(
                _setToken.invoke(address(_cToken), 0, abi.encodeWithSignature("redeemUnderlying(uint256)", _redeemNotional)),
                (uint256)
            ) == 0,
            "Redeem failed"
        );

        if (_cToken == cEther) {
            _setToken.invokeWrapWETH(address(weth), _redeemNotional);
        }
    }

    /**
     * Invoke repay from SetToken. If cEther then unwrap WETH into ETH.
     */
    function _repayBorrow(ISetToken _setToken, ICErc20 _cToken, IERC20 _underlyingToken, uint256 _repayNotional) internal {
        if (_cToken == cEther) {
            _setToken.invokeUnwrapWETH(address(weth), _repayNotional);

            // Compound's repay ETH function signature is: repayBorrow(). No return, revert on fail
            _setToken.invoke(address(_cToken), _repayNotional, abi.encodeWithSignature("repayBorrow()"));
        } else {
            // Approve to cToken
            _setToken.invokeApprove(address(_underlyingToken), address(_cToken), _repayNotional);
            // Compound's repay asset function signature is: repayBorrow(uint256 _repayAmount)
            require(
                abi.decode(
                    _setToken.invoke(address(_cToken), 0, abi.encodeWithSignature("repayBorrow(uint256)", _repayNotional)),
                    (uint256)
                ) == 0,
                "Repay failed"
            );
        }
    }

    /**
     * Invoke the SetToken to interact with the specified cToken to borrow the cToken's underlying of the specified borrowQuantity.
     */
    function _borrow(ISetToken _setToken, ICErc20 _cToken, uint256 _notionalBorrowQuantity) internal {
        // Compound's borrow function signature is: borrow(uint256 _borrowAmount). Note: Notional borrow quantity is in units of underlying asset
        require(
            abi.decode(
                _setToken.invoke(address(_cToken), 0, abi.encodeWithSignature("borrow(uint256)", _notionalBorrowQuantity)),
                (uint256)
            ) == 0,
            "Borrow failed"
        );
        if (_cToken == cEther) {
            _setToken.invokeWrapWETH(address(weth), _notionalBorrowQuantity);
        }
    }

    /**
     * Executes a trade, validates the minimum receive quantity is returned, and pays protocol fee (if applicable)
     *
     * @return uint256          Amount of protocol fees in receive token
     * @return uint256          Amount of receive token net of protocol fees
     */
    function _tradeAndHandleFees(
        ISetToken _setToken,
        IERC20 _sendToken,
        IERC20 _receiveToken,
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

        uint256 receiveTokenQuantity = _receiveToken.balanceOf(address(_setToken)).sub(_preTradeReceiveTokenBalance);
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
        IERC20 _sendToken,
        IERC20 _receiveToken,
        uint256 _notionalSendQuantity,
        uint256 _minNotionalReceiveQuantity,
        IExchangeAdapter _exchangeAdapter,
        bytes memory _data
    )
        internal
    {
         _setToken.invokeApprove(
            address(_sendToken),
            _exchangeAdapter.getSpender(),
            _notionalSendQuantity
        );

        (
            address targetExchange,
            uint256 callValue,
            bytes memory methodData
        ) = _exchangeAdapter.getTradeCalldata(
            address(_sendToken),
            address(_receiveToken),
            address(_setToken),
            _notionalSendQuantity,
            _minNotionalReceiveQuantity,
            _data
        );

        _setToken.invoke(targetExchange, callValue, methodData);
    }

    /**
     * Calculates protocol fee on module and pays protocol fee from SetToken
     */
    function _accrueProtocolFee(ISetToken _setToken, IERC20 _receiveToken, uint256 _exchangedQuantity) internal returns(uint256) {
        uint256 protocolFeeTotal = getModuleFee(PROTOCOL_TRADE_FEE_INDEX, _exchangedQuantity);
        
        payProtocolFeeFromSetToken(_setToken, address(_receiveToken), protocolFeeTotal);

        return protocolFeeTotal;
    }

    function _updateCollateralPosition(ISetToken _setToken, ICErc20 _cToken, uint256 _newPositionUnit) internal {
        _setToken.editDefaultPosition(address(_cToken), _newPositionUnit);
    }

    function _updateBorrowPosition(ISetToken _setToken, IERC20 _underlyingToken, int256 _newPositionUnit) internal {
        _setToken.editExternalPosition(address(_underlyingToken), address(this), _newPositionUnit, "");
    }

    /**
     * Construct the ActionInfo struct for lever and delever
     */
    function _createActionInfo(
        ISetToken _setToken,
        IERC20 _sendToken,
        IERC20 _receiveToken,
        uint256 _sendQuantity,
        uint256 _minReceiveQuantity,
        string memory _tradeAdapterName,
        bool isLever
    )
        internal
        view
        returns(ActionInfo memory)
    {
        uint256 totalSupply = _setToken.totalSupply();
        return ActionInfo ({
            exchangeAdapter: IExchangeAdapter(getAndValidateAdapter(_tradeAdapterName)),
            setToken: _setToken,
            collateralCTokenAsset: isLever ? underlyingToCToken[_receiveToken] : underlyingToCToken[_sendToken],
            borrowCTokenAsset: isLever ? underlyingToCToken[_sendToken] : underlyingToCToken[_receiveToken],
            setTotalSupply: totalSupply,
            notionalSendQuantity: _sendQuantity.preciseMul(totalSupply),
            minNotionalReceiveQuantity: _minReceiveQuantity.preciseMul(totalSupply),
            preTradeReceiveTokenBalance: IERC20(_receiveToken).balanceOf(address(_setToken))
        });
    }

    /**
     * Construct the ActionInfo struct for gulp and validate gulp info.
     */
    function _createGulpInfoAndValidate(
        ISetToken _setToken,
        IERC20 _collateralAsset,
        string memory _tradeAdapterName
    )
        internal
        view
        returns(ActionInfo memory)
    {
        ICErc20 collateralCTokenAsset = underlyingToCToken[_collateralAsset];
        // Validate collateral is enabled
        require(collateralCTokenEnabled[_setToken][collateralCTokenAsset], "Collateral is not enabled");

        ActionInfo memory actionInfo;
        actionInfo.collateralCTokenAsset = collateralCTokenAsset;

        actionInfo.exchangeAdapter = IExchangeAdapter(getAndValidateAdapter(_tradeAdapterName));
        actionInfo.setTotalSupply = _setToken.totalSupply();
        // Snapshot pre trade receive token balance.
        actionInfo.preTradeReceiveTokenBalance = _collateralAsset.balanceOf(address(_setToken));
        
        // Calculate notional send quantity by comparing balance of COMP after claiming against the total notional units
        // of COMP tracked on the SetToken
        uint256 defaultCompPositionNotional = _setToken
            .getDefaultPositionRealUnit(address(compToken))
            .toUint256()
            .preciseMul(actionInfo.setTotalSupply);

        actionInfo.notionalSendQuantity = compToken.balanceOf(address(_setToken)).sub(defaultCompPositionNotional);
        require(actionInfo.notionalSendQuantity > 0, "Claim is 0");

        return actionInfo;
    }

    function _validateCommon(ActionInfo memory _actionInfo) internal view {
        require(collateralCTokenEnabled[_actionInfo.setToken][_actionInfo.collateralCTokenAsset], "Collateral not enabled");
        require(borrowCTokenEnabled[_actionInfo.setToken][_actionInfo.borrowCTokenAsset], "Borrow not enabled");
        require(_actionInfo.collateralCTokenAsset != _actionInfo.borrowCTokenAsset, "Must be different");
        require(_actionInfo.notionalSendQuantity > 0, "Quantity is 0");
    }

    function _getCollateralPosition(ISetToken _setToken, ICErc20 _cToken, uint256 _setTotalSupply) internal view returns (uint256) {
        uint256 collateralNotionalBalance = _cToken.balanceOf(address(_setToken));
        return collateralNotionalBalance.preciseDiv(_setTotalSupply);
    }

    function _getBorrowPosition(ISetToken _setToken, ICErc20 _cToken, uint256 _setTotalSupply) internal returns (int256) {
        uint256 borrowNotionalBalance = _cToken.borrowBalanceCurrent(address(_setToken));
        // Round negative away from 0
        return borrowNotionalBalance.preciseDivCeil(_setTotalSupply).toInt256().mul(-1);
    }
}