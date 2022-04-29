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
import { IERC777 } from "@openzeppelin/contracts/token/ERC777/IERC777.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IController } from "../../../interfaces/IController.sol";
import { IDebtIssuanceModule } from "../../../interfaces/IDebtIssuanceModule.sol";
import { IModuleIssuanceHook } from "../../../interfaces/IModuleIssuanceHook.sol";
import { IWrappedfCash, IWrappedfCashComplete } from "../../../interfaces/IWrappedFCash.sol";
import { ISetToken } from "../../../interfaces/ISetToken.sol";
import { ModuleBase } from "../../lib/ModuleBase.sol";
import "@openzeppelin/contracts/utils/EnumerableSet.sol";


contract NotionalTradeModule is ModuleBase, ReentrancyGuard, Ownable, IModuleIssuanceHook {
    using EnumerableSet for EnumerableSet.AddressSet;

    /* ============ Structs ============ */


    /* ============ Events ============ */

    /**
     * @dev Emitted on updateAnySetAllowed()
     * @param _anySetAllowed    true if any set is allowed to initialize this module, false otherwise
     */
    event AnySetAllowedUpdated(
        bool indexed _anySetAllowed
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

    /* ============ Constants ============ */

    // String identifying the DebtIssuanceModule in the IntegrationRegistry. Note: Governance must add DefaultIssuanceModule as
    // the string as the integration name
    string constant internal DEFAULT_ISSUANCE_MODULE_NAME = "DefaultIssuanceModule";

    /* ============ State Variables ============ */

    // Internal mapping of enabled collateral and borrow tokens for syncing positions
    mapping(ISetToken => bool) internal redeemToUnderlying;

    // Mapping of SetToken to boolean indicating if SetToken is on allow list. Updateable by governance
    mapping(ISetToken => bool) public allowedSetTokens;

    // Mapping of SetToken to fCash positions
    mapping(ISetToken => EnumerableSet.AddressSet) private fCashPositions;

    // Boolean that returns if any SetToken can initialize this module. If false, then subject to allow list. Updateable by governance.
    bool public anySetAllowed;

    /* ============ Constructor ============ */

    constructor(
        IController _controller
    )
        public
        ModuleBase(_controller)
    {
    }

    /* ============ External Functions ============ */

    function trade(
        ISetToken _setToken,
        address _sendToken,
        uint256 _sendQuantity,
        address _receiveToken,
        uint256 _minReceiveQuantity,
        bool _useUnderlying
    )
        external
        nonReentrant
        onlyManagerAndValidSet(_setToken)
        returns(uint256)
    {
        if(fCashPositions[_setToken].contains(_sendToken))
        {
            return _redeemFCashPosition(_setToken, IWrappedfCashComplete(_sendToken), _sendQuantity, _useUnderlying);
        }
        else if(fCashPositions[_setToken].contains(_receiveToken))
        {
            return _mintFCashPosition(_setToken, IWrappedfCashComplete(_receiveToken), _minReceiveQuantity, _sendQuantity, _useUnderlying);
        }
        else {
            revert("Neither send nor receive token is a registered fCash position");
        }

    }

    function redeemMaturedPositions(ISetToken _setToken) public nonReentrant onlyValidAndInitializedSet(_setToken) {
        _redeemMaturedPositions(_setToken);
    }

    function initialize(
        ISetToken _setToken,
        address[] calldata _fCashPositions
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

        // _collateralAssets and _borrowAssets arrays are validated in their respective internal functions
        _addFCashPositions(_setToken, _fCashPositions);
    }

    /**
     * @dev MANAGER ONLY: Removes this module from the SetToken, via call by the SetToken. Any deposited collateral assets
     * are disabled to be used as collateral on Aave. Aave Settings and manager enabled assets state is deleted.
     * Note: Function will revert is there is any debt remaining on Aave
     */
    function removeModule() external override onlyValidAndInitializedSet(ISetToken(msg.sender)) {
        ISetToken setToken = ISetToken(msg.sender);

        // Redeem matured positions prior to any removal action
        _redeemMaturedPositions(setToken);

        delete fCashPositions[setToken];

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

    function moduleIssueHook(ISetToken _setToken, uint256 /* _setTokenQuantity */) external override onlyModule(_setToken) {
        _redeemMaturedPositions(_setToken);
    }

    function moduleRedeemHook(ISetToken _setToken, uint256 /* _setTokenQuantity */) external override onlyModule(_setToken) {
        _redeemMaturedPositions(_setToken);
    }


    function componentIssueHook(
        ISetToken _setToken,
        uint256 _setTokenQuantity,
        IERC20 _component,
        bool _isEquity
    ) external override onlyModule(_setToken) {
    }

    function componentRedeemHook(
        ISetToken _setToken,
        uint256 _setTokenQuantity,
        IERC20 _component,
        bool _isEquity
    ) external override onlyModule(_setToken) {
    }




    /* ============ External Getter Functions ============ */

    function getFCashPositions(ISetToken _setToken) external view returns(address[] memory positions) {
        uint256 length = fCashPositions[_setToken].length();
        for(uint256 i = 0; i < length; i++) {
            positions[i] = fCashPositions[_setToken].at(i);
        }
    }

    /* ============ Internal Functions ============ */

    function _redeemMaturedPositions(ISetToken _setToken) internal {
        uint fCashPositionLength = fCashPositions[_setToken].length();
        if(fCashPositionLength == 0) return;

        bool toUnderlying = redeemToUnderlying[_setToken];

        for(uint256 i = 0; i < fCashPositionLength; i++) {
            IWrappedfCashComplete fCashPosition = IWrappedfCashComplete(fCashPositions[_setToken].at(i));

            if(fCashPosition.hasMatured()) {
                uint256 fCashBalance = fCashPosition.balanceOf(address(_setToken));
                _redeemFCashPosition(_setToken, fCashPosition, fCashBalance, toUnderlying);
                if(_setToken.isComponent(address(fCashPosition))) {
                    _setToken.removeComponent(address(fCashPosition));
                }
            }

        }

    }

    function _setOperatorIfNecessary(ISetToken _setToken, IWrappedfCashComplete _fCashPosition) internal {
        if(!IERC777(address(_fCashPosition)).isOperatorFor(address(this), address(_setToken))){
            bytes memory authorizeCallData = abi.encodeWithSignature( "authorizeOperator(address)", address(this));
            _setToken.invoke(address(_fCashPosition), 0, authorizeCallData);
        }
    }

    function _redeemFCashPosition(ISetToken _setToken, IWrappedfCashComplete _fCashPosition, uint256 _amount, bool _toUnderlying) internal returns(uint256) {
        if(_amount == 0) return 0;
        _setOperatorIfNecessary(_setToken, _fCashPosition);

        // TODO: Review if this value is correct / what is max implied rate ? 
        uint32 maxImpliedRate = type(uint32).max;

        IERC20 receiveToken;
        if(_toUnderlying) {
            (receiveToken,) = _fCashPosition.getUnderlyingToken();
        } else {
            (receiveToken,,) = _fCashPosition.getAssetToken();
        }

        uint256 balanceBefore = receiveToken.balanceOf(address(_setToken));
        IERC777(address(_fCashPosition)).operatorBurn(
            address(_setToken),
            _amount,
            abi.encode(IWrappedfCash.RedeemOpts(_toUnderlying, false, address(_setToken), maxImpliedRate)),
            ""
        );
        uint256 balanceAfter = receiveToken.balanceOf(address(_setToken));
        return balanceAfter.sub(balanceBefore);

    }

    function _mintFCashPosition(
        ISetToken _setToken,
        IWrappedfCashComplete _fCashPosition,
        uint256 _fCashAmount,
        uint256 _maxAssetAmount,
        bool _useUnderlying
    )
    internal
    returns(uint256 assetAmountSpent)
    {
        if(_fCashAmount == 0) return 0;
        // TODO: Review if this value is correct / what is max implied rate ? 
        uint32 minImpliedRate = 0;

        IERC20 paymentToken;
        if(_useUnderlying) {
            (paymentToken,) = _fCashPosition.getUnderlyingToken();
        } else {
            (paymentToken,,) = _fCashPosition.getAssetToken();
        }

        if(IERC20(paymentToken).allowance(address(_setToken), address(_fCashPosition)) < _maxAssetAmount) {
            bytes memory approveCallData = abi.encodeWithSignature("approve(address,uint256)", address(_fCashPosition), _maxAssetAmount);
            _setToken.invoke(address(paymentToken), 0, approveCallData);
        }


        uint256 balanceBefore = paymentToken.balanceOf(address(_setToken));
        bytes memory mintCallData = abi.encodeWithSignature(
            "mint(uint256,uint88,address,uint32,bool)",
            _maxAssetAmount,
            uint88(_fCashAmount),
            address(_setToken),
            minImpliedRate,
            _useUnderlying
        );
        _setToken.invoke(address(_fCashPosition), 0, mintCallData);
        assetAmountSpent = balanceBefore.sub(paymentToken.balanceOf(address(_setToken)));
        require(assetAmountSpent <= _maxAssetAmount, "Overpaid");
    }

    function _addFCashPositions(ISetToken _setToken, address[] calldata _fCashPositions) internal {
        for(uint256 i = 0; i < _fCashPositions.length; i++) {
            fCashPositions[_setToken].add(_fCashPositions[i]);
        }
    }
}
