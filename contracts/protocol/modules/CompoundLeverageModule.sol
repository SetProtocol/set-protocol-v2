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
import { Math } from "@openzeppelin/contracts/math/Math.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";

import { AddressArrayUtils } from "../../lib/AddressArrayUtils.sol";
import { ICErc20 } from "../../interfaces/external/ICErc20.sol";
import { IComptroller } from "../../interfaces/external/IComptroller.sol";
import { IController } from "../../interfaces/IController.sol";
import { IDebtIssuanceModule } from "../../interfaces/IDebtIssuanceModule.sol";
import { IExchangeAdapter } from "../../interfaces/IExchangeAdapter.sol";
import { Invoke } from "../lib/Invoke.sol";
import { ISetToken } from "../../interfaces/ISetToken.sol";
import { ModuleBase } from "../lib/ModuleBase.sol";
import { Position } from "../lib/Position.sol";
import { PreciseUnitMath } from "../../lib/PreciseUnitMath.sol";

/**
 * @title CompoundLeverageModule
 * @author Set Protocol
 *
 * Smart contract that enables leverage trading using Compound as the lending protocol. This module allows for multiple Compound leverage positions
 * in a SetToken. This does not allow borrowing of assets from Compound alone. Each asset is leveraged when using this module.
 *
 */
contract CompoundLeverageModule is ModuleBase, ReentrancyGuard, Ownable {
    using AddressArrayUtils for address[];
    using Invoke for ISetToken;
    using Position for ISetToken;
    using PreciseUnitMath for uint256;
    using SafeCast for int256;
    using SafeCast for uint256;
    using SafeMath for uint256;
    using SignedSafeMath for int256;

    /* ============ Structs ============ */

    struct CompoundSettings {
        address[] collateralCTokens;             // Array of enabled cToken collateral assets for a SetToken
        address[] borrowCTokens;                 // Array of enabled cToken borrow assets for a SetToken
        address[] borrowAssets;                  // Array of underlying borrow assets
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

    event CollateralAssetAdded(
        ISetToken indexed _setToken,
        address _asset
    );

    event CollateralAssetRemoved(
        ISetToken indexed _setToken,
        address _asset
    );

    event BorrowAssetAdded(
        ISetToken indexed _setToken,
        address _asset
    );

    event BorrowAssetRemoved(
        ISetToken indexed _setToken,
        address _asset
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
    address public weth;

    // Compound cEther address
    address public cEther;

    // Compound Comptroller contract
    IComptroller public comptroller;

    // COMP token address
    address public compToken;

    // Mapping to efficiently check if cToken market for collateral asset is valid in SetToken
    mapping(ISetToken => mapping(address => bool)) public isCollateralCTokenEnabled;

    // Mapping to efficiently check if cToken market for borrow asset is valid in SetToken
    mapping(ISetToken => mapping(address => bool)) public isBorrowCTokenEnabled;

    // Mapping of enabled collateral and borrow cTokens for syncing positions
    mapping(ISetToken => CompoundSettings) internal compoundSettings;

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
     * MANAGER ONLY: Increases leverage for a given collateral position using a specified borrow asset that is enabled.
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
                _borrowAsset,
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
     * MANAGER ONLY: Decrease leverage for a given collateral position using a specified borrow asset that is enabled
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
            _getBorrowPosition(deleverInfo.setToken, deleverInfo.borrowCTokenAsset, _repayAsset, deleverInfo.setTotalSupply)
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
     * MANAGER ONLY: Claims COMP and trades for specified collateral asset
     *
     * @param _setToken                      Instance of the SetToken
     * @param _collateralAsset               Address of collateral asset
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
        ActionInfo memory gulpInfo = _createGulpInfoClaimAndValidate(
            _setToken,
            _collateralAsset,
            _tradeAdapterName
        );

        uint256 protocolFee = 0;
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
            for(uint256 i = 0; i < compoundSettings[_setToken].collateralCTokens.length; i++) {
                address collateralCToken = compoundSettings[_setToken].collateralCTokens[i];
                uint256 previousPositionUnit = _setToken.getDefaultPositionRealUnit(collateralCToken).toUint256();
                uint256 newPositionUnit = _getCollateralPosition(_setToken, collateralCToken, setTotalSupply);

                // Note: Accounts for if position does not exist on SetToken but is tracked in compoundSettings
                if (previousPositionUnit != newPositionUnit) {
                  _updateCollateralPosition(_setToken, collateralCToken, newPositionUnit);
                }
            }

            // Loop through borrow assets
            for(uint256 i = 0; i < compoundSettings[_setToken].borrowCTokens.length; i++) {
                address borrowCToken = compoundSettings[_setToken].borrowCTokens[i];
                address borrowAsset = compoundSettings[_setToken].borrowAssets[i];

                int256 previousPositionUnit = _setToken.getExternalPositionRealUnit(borrowAsset, address(this));

                int256 newPositionUnit = _getBorrowPosition(
                    _setToken,
                    borrowCToken,
                    borrowAsset,
                    setTotalSupply
                );

                // Note: Accounts for if position does not exist on SetToken but is tracked in compoundSettings
                // If borrow position unit is > 0 then update position
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
            require(allowList[_setToken], "Must be allowlisted");
        }

        // Initialize module before trying register
        _setToken.initializeModule();

        // Get debt issuance module registered to this module and require that it is initialized
        require(_setToken.isInitializedModule(getAndValidateAdapter(DEFAULT_ISSUANCE_MODULE_NAME)), "Debt issuance must be initialized");

        // Try if register exists on any of the modules including the debt issuance module
        address[] memory modules = _setToken.getModules();
        for(uint256 i = 0; i < modules.length; i++) {
            try IDebtIssuanceModule(modules[i]).register(_setToken) {} catch {}
        }
        
        // Enable collateral and borrow assets on Compound
        for(uint256 i = 0; i < _collateralAssets.length; i++) {
            addCollateralAsset(_setToken, _collateralAssets[i]);
        }

        for(uint256 i = 0; i < _borrowAssets.length; i++) {
            addBorrowAsset(_setToken, _borrowAssets[i]);
        }
    }

    /**
     * MANAGER ONLY: Removes this module from the SetToken, via call by the SetToken. Only callable by SetToken manager. Compound Settings and manager enabled
     * cTokens are deleted. Markets are exited on Comptroller (only valid if borrow balances are zero)
     */
    function removeModule() external override {
        ISetToken setToken = ISetToken(msg.sender);

        // Sync Compound and SetToken positions prior to any removal action
        sync(setToken);

        for (uint256 i = 0; i < compoundSettings[setToken].borrowCTokens.length; i++) {
            address cToken = compoundSettings[setToken].borrowCTokens[i];

            // Note: if there is an existing borrow balance, will revert and market cannot be exited on Compound
            _exitMarket(setToken, cToken);

            delete isBorrowCTokenEnabled[setToken][cToken];
        }

        for (uint256 i = 0; i < compoundSettings[setToken].collateralCTokens.length; i++) {
            address cToken = compoundSettings[setToken].collateralCTokens[i];

            _exitMarket(setToken, cToken);

            delete isCollateralCTokenEnabled[setToken][cToken];
        }
        
        delete compoundSettings[setToken];

        // Try if unregister exists on any of the modules
        address[] memory modules = setToken.getModules();
        for(uint256 i = 0; i < modules.length; i++) {
            try IDebtIssuanceModule(modules[i]).unregister(setToken) {} catch {}
        }
    }

    /**
     * ANYONE CALLABLE: Add registration of this module on debt issuance module for the SetToken. Note: if the debt issuance module is not added to SetToken
     * before this module is initialized, then this function needs to be called if the debt issuance module is later added and initialized to prevent state
     * inconsistencies
     *
     * @param _setToken             Instance of the SetToken
     * @param _debtIssuanceModule   Debt issuance module address to register
     */
    function addRegister(ISetToken _setToken, address _debtIssuanceModule) external onlyValidAndInitializedSet(_setToken) {
        require(_setToken.isInitializedModule(_debtIssuanceModule), "Debt issuance must be initialized");

        IDebtIssuanceModule(_debtIssuanceModule).register(_setToken);
    }

    /**
     * MANAGER ONLY: Add enabled collateral asset. Only callable by manager. Collateral asset is tracked for syncing positions and entered in Compound markets
     *
     * @param _setToken             Instance of the SetToken
     * @param _newCollateralAsset   Address of new collateral underlying asset
     */
    function addCollateralAsset(ISetToken _setToken, address _newCollateralAsset) public onlyManagerAndValidSet(_setToken) {
        address cToken = underlyingToCToken[_newCollateralAsset];
        require(cToken != address(0), "cToken must exist");
        require(!isCollateralCTokenEnabled[_setToken][cToken], "Collateral is enabled");
        
        // Note: Will only enter market if cToken is not enabled as a borrow asset as well
        if (!isBorrowCTokenEnabled[_setToken][cToken]) {
            address[] memory marketsToEnter = new address[](1);
            marketsToEnter[0] = cToken;
            _enterMarkets(_setToken, marketsToEnter);
        }

        isCollateralCTokenEnabled[_setToken][cToken] = true;
        compoundSettings[_setToken].collateralCTokens.push(cToken);

        emit CollateralAssetAdded(_setToken, _newCollateralAsset);
    }

    /**
     * MANAGER ONLY: Remove collateral asset. Only callable by manager. Collateral asset exited in Compound markets
     * If there is a borrow balance, collateral asset cannot be removed
     *
     * @param _setToken             Instance of the SetToken
     * @param _collateralAsset      Address of collateral underlying asset to remove
     */
    function removeCollateralAsset(ISetToken _setToken, address _collateralAsset) external onlyManagerAndValidSet(_setToken) {
        // Sync Compound and SetToken positions prior to any removal action
        sync(_setToken);

        address cToken = underlyingToCToken[_collateralAsset];
        require(isCollateralCTokenEnabled[_setToken][cToken], "Collateral is not enabled");
        
        // Note: Will only exit market if cToken is not enabled as a borrow asset as well
        // If there is an existing borrow balance, will revert and market cannot be exited on Compound
        if (!isBorrowCTokenEnabled[_setToken][cToken]) {
            _exitMarket(_setToken, cToken);
        }

        delete isCollateralCTokenEnabled[_setToken][cToken];
        compoundSettings[_setToken].collateralCTokens = compoundSettings[_setToken].collateralCTokens.remove(cToken);

        emit CollateralAssetRemoved(_setToken, _collateralAsset);
    }

    /**
     * MANAGER ONLY: Add borrow asset. Only callable by manager. Borrow asset is tracked for syncing positions and entered in Compound markets
     *
     * @param _setToken             Instance of the SetToken
     * @param _newBorrowAsset       Address of borrow underlying asset to add
     */
    function addBorrowAsset(ISetToken _setToken, address _newBorrowAsset) public onlyManagerAndValidSet(_setToken) {
        address cToken = underlyingToCToken[_newBorrowAsset];
        require(cToken != address(0), "cToken must exist");
        require(!isBorrowCTokenEnabled[_setToken][cToken], "Borrow is enabled");
        
        // Note: Will only enter market if cToken is not enabled as a borrow asset as well
        if (!isCollateralCTokenEnabled[_setToken][cToken]) {
            address[] memory marketsToEnter = new address[](1);
            marketsToEnter[0] = cToken;
            _enterMarkets(_setToken, marketsToEnter);
        }

        isBorrowCTokenEnabled[_setToken][cToken] = true;
        compoundSettings[_setToken].borrowCTokens.push(cToken);
        compoundSettings[_setToken].borrowAssets.push(_newBorrowAsset);

        emit BorrowAssetAdded(_setToken, _newBorrowAsset);
    }

    /**
     * MANAGER ONLY: Remove borrow asset. Only callable by manager. Borrow asset is exited in Compound markets
     * If there is a borrow balance, borrow asset cannot be removed
     *
     * @param _setToken             Instance of the SetToken
     * @param _borrowAsset          Address of borrow underlying asset to remove
     */
    function removeBorrowAsset(ISetToken _setToken, address _borrowAsset) external onlyManagerAndValidSet(_setToken) {
        // Sync Compound and SetToken positions prior to any removal action
        sync(_setToken);

        address cToken = underlyingToCToken[_borrowAsset];
        require(isBorrowCTokenEnabled[_setToken][cToken], "Borrow is not enabled");
        
        // Note: Will only exit market if cToken is not enabled as a collateral asset as well
        // If there is an existing borrow balance, will revert and market cannot be exited on Compound
        if (!isCollateralCTokenEnabled[_setToken][cToken]) {
            _exitMarket(_setToken, cToken);
        }

        delete isBorrowCTokenEnabled[_setToken][cToken];
        compoundSettings[_setToken].borrowCTokens = compoundSettings[_setToken].borrowCTokens.remove(cToken);
        compoundSettings[_setToken].borrowAssets = compoundSettings[_setToken].borrowAssets.remove(_borrowAsset);

        emit BorrowAssetRemoved(_setToken, _borrowAsset);
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
     */
    function addCompoundMarket(address _cToken, address _underlying) external onlyOwner {
        require(underlyingToCToken[_underlying] == address(0), "cToken already enabled");

        underlyingToCToken[_underlying] = _cToken;
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
        uint256 notionalDebt = componentDebt.mul(-1).toUint256().preciseMul(_setTokenQuantity);

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
            compoundSettings[_setToken].collateralCTokens,
            compoundSettings[_setToken].borrowAssets
        );
    }

    /* ============ Internal Functions ============ */

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
     * Construct the ActionInfo struct for gulp, claim COMP, and validate gulp info.
     */
    function _createGulpInfoClaimAndValidate(
        ISetToken _setToken,
        address _collateralAsset,
        string memory _tradeAdapterName
    )
        internal
        returns(ActionInfo memory)
    {
        ActionInfo memory actionInfo;

        // Create gulp info struct
        actionInfo.collateralCTokenAsset = underlyingToCToken[_collateralAsset];
        actionInfo.exchangeAdapter = IExchangeAdapter(getAndValidateAdapter(_tradeAdapterName));
        actionInfo.setTotalSupply = _setToken.totalSupply();
        
        // Validate collateral is enabled
        require(isCollateralCTokenEnabled[_setToken][actionInfo.collateralCTokenAsset], "Collateral is not enabled");
        
        // Snapshot COMP balances pre claim
        uint256 preClaimCompBalance = IERC20(compToken).balanceOf(address(_setToken));

        // Claim COMP
        _claim(_setToken);

        // Snapshot pre trade receive token balance.
        actionInfo.preTradeReceiveTokenBalance = IERC20(_collateralAsset).balanceOf(address(_setToken));
        // Calculate notional send quantity
        actionInfo.notionalSendQuantity = IERC20(compToken).balanceOf(address(_setToken)).sub(preClaimCompBalance);

        // Validate trade quantity is nonzero
        require(actionInfo.notionalSendQuantity > 0, "Token to sell must be nonzero");

        return actionInfo;
    }

    function _validateCommon(ActionInfo memory _actionInfo) internal view {
        require(isCollateralCTokenEnabled[_actionInfo.setToken][_actionInfo.collateralCTokenAsset], "Collateral is not enabled");
        require(isBorrowCTokenEnabled[_actionInfo.setToken][_actionInfo.borrowCTokenAsset], "Borrow is not enabled");
        require(_actionInfo.collateralCTokenAsset != _actionInfo.borrowCTokenAsset, "Must be different");
        require(_actionInfo.notionalSendQuantity > 0, "Token to sell must be nonzero");
    }

    /**
     * Invoke enter markets from SetToken
     */
    function _enterMarkets(ISetToken _setToken, address[] memory _cTokens) internal {
        // Compound's enter market function signature is: enterMarkets(address[] _cTokens)
        bytes memory enterMarketsCallData = abi.encodeWithSignature("enterMarkets(address[])", _cTokens);
        bytes memory returndata = _setToken.invoke(address(comptroller), 0, enterMarketsCallData);

        uint256[] memory returnValues = abi.decode(returndata, (uint256[]));
        for (uint256 i = 0; i < _cTokens.length; i++) {
            require(
                returnValues[i] == 0,
                "Entering market failed"
            );
        }
    }

    /**
     * Invoke exit market from SetToken
     */
    function _exitMarket(ISetToken _setToken, address _cToken) internal {
        // Compound's exit market function signature is: exitMarket(address _cToken)
        bytes memory exitMarketCallData = abi.encodeWithSignature("exitMarket(address)", _cToken);
        bytes memory returndata = _setToken.invoke(address(comptroller), 0, exitMarketCallData);
        require(
            abi.decode(returndata, (uint256)) == 0,
            "Exiting market failed"
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
            bytes memory mintCEthCallData = abi.encodeWithSignature("mint()");
            _setToken.invoke(_cToken, _mintNotional, mintCEthCallData);
        } else {
            _setToken.invokeApprove(_underlyingToken, _cToken, _mintNotional);

            // Compound's mint cToken function signature is: mint(uint256 _mintAmount). Returns 0 if success
            bytes memory mintCallData = abi.encodeWithSignature("mint(uint256)", _mintNotional);
            bytes memory returndata = _setToken.invoke(_cToken, 0, mintCallData);
            require(
                abi.decode(returndata, (uint256)) == 0,
                "Mint failed"
            );
        }
    }

    /**
     * Invoke redeem from SetToken. If cEther, then also wrap ETH into WETH.
     */
    function _redeemUnderlying(ISetToken _setToken, address _cToken, uint256 _redeemNotional) internal {
        // Compound's redeem function signature is: redeemUnderlying(uint256 _underlyingAmount)
        bytes memory redeemCallData = abi.encodeWithSignature("redeemUnderlying(uint256)", _redeemNotional);
        bytes memory returndata = _setToken.invoke(_cToken, 0, redeemCallData);
        require(
            abi.decode(returndata, (uint256)) == 0,
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
            bytes memory repayCEthCallData = abi.encodeWithSignature("repayBorrow()");
            _setToken.invoke(_cToken, _repayNotional, repayCEthCallData);
        } else {
            // Approve to cToken
            _setToken.invokeApprove(_underlyingToken, _cToken, _repayNotional);
            // Compound's repay asset function signature is: repayBorrow(uint256 _repayAmount)
            bytes memory repayCallData = abi.encodeWithSignature("repayBorrow(uint256)", _repayNotional);
            bytes memory returndata = _setToken.invoke(_cToken, 0, repayCallData);
            require(
                abi.decode(returndata, (uint256)) == 0,
                "Repay failed"
            );
        }
    }

    /**
     * Invoke the SetToken to interact with the specified cToken to borrow the cToken's underlying of the specified borrowQuantity.
     */
    function _borrow(ISetToken _setToken, address _cToken, uint256 _notionalBorrowQuantity) internal {
        // Compound's borrow function signature is: borrow(uint256 _borrowAmount). Note: Notional borrow quantity is in units of underlying asset
        bytes memory borrowCallData = abi.encodeWithSignature("borrow(uint256)", _notionalBorrowQuantity);
        bytes memory returndata = _setToken.invoke(_cToken, 0, borrowCallData);
        require(
            abi.decode(returndata, (uint256)) == 0,
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
            "Slippage greater than allowed"
        );

        uint256 protocolFeeTotal = _accrueProtocolFee(_setToken, _receiveToken, receiveTokenQuantity);

        return (protocolFeeTotal, receiveTokenQuantity.sub(protocolFeeTotal));
    }

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

    function _accrueProtocolFee(ISetToken _setToken, address _receiveToken, uint256 _exchangedQuantity) internal returns(uint256) {
        uint256 protocolFeeTotal = getModuleFee(PROTOCOL_TRADE_FEE_INDEX, _exchangedQuantity);
        
        payProtocolFeeFromSetToken(_setToken, _receiveToken, protocolFeeTotal);

        return protocolFeeTotal;
    }

    /**
     * Invoke claim COMP from SetToken
     */
    function _claim(ISetToken _setToken) internal {
        // Compound's claim COMP function signature is: claimComp(address _holder)
        bytes memory claimCallData = abi.encodeWithSignature("claimComp(address)", address(_setToken));

        _setToken.invoke(address(comptroller), 0, claimCallData);
    }

    function _getCollateralPosition(ISetToken _setToken, address _cToken, uint256 _setTotalSupply) internal view returns (uint256) {
        uint256 collateralNotionalBalance = IERC20(_cToken).balanceOf(address(_setToken));
        return collateralNotionalBalance.preciseDiv(_setTotalSupply);
    }

    function _getBorrowPosition(ISetToken _setToken, address _cToken, address _underlyingToken, uint256 _setTotalSupply) internal returns (int256) {
        uint256 borrowNotionalBalance = ICErc20(_cToken).borrowBalanceCurrent(address(_setToken));
        // Round negative away from 0
        return borrowNotionalBalance.preciseDivCeil(_setTotalSupply).toInt256().mul(-1);
    }

    function _updateCollateralPosition(ISetToken _setToken, address _cToken, uint256 _newPositionUnit) internal {
        _setToken.editDefaultPosition(_cToken, _newPositionUnit);
    }

    function _updateBorrowPosition(ISetToken _setToken, address _underlyingToken, int256 _newPositionUnit) internal {
        _setToken.editExternalPosition(_underlyingToken, address(this), _newPositionUnit, "");
    }
}