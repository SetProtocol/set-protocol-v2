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

    /**
     * @dev Emitted when minting new FCash
     * @param _setToken         SetToken on whose behalf fcash was minted
     * @param _fCashPosition    Address of wrappedFCash token
     * @param _sendToken        Address of send token used to pay for minting
     * @param _fCashAmount      Amount of fCash minted
     * @param _sentAmount       Amount of sendToken spent
     */
    event FCashMinted(
        ISetToken indexed _setToken,
        IWrappedfCashComplete indexed _fCashPosition,
        IERC20 indexed _sendToken, 
        uint256 _fCashAmount,
        uint256 _sentAmount
    );

    /**
     * @dev Emitted when redeeming new FCash
     * @param _setToken         SetToken on whose behalf fcash was redeemed
     * @param _fCashPosition    Address of wrappedFCash token
     * @param _receiveToken     Address of receive token used to pay for redeeming
     * @param _fCashAmount      Amount of fCash redeemed / burned
     * @param _receivedAmount   Amount of receiveToken received
     */
    event FCashRedeemed(
        ISetToken indexed _setToken,
        IWrappedfCashComplete indexed _fCashPosition,
        IERC20 indexed _receiveToken, 
        uint256 _fCashAmount,
        uint256 _receivedAmount
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

    // Mapping of SetToken to fCash positions that are availabe for trading on this fCash token and that are monitored for maturity
    // TODO: Check / Compare alternative ways to handle this. Maybe remove this mapping and just use the set token components list ? 
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

    /**
     * @dev MANAGER ONLY: Trades in or out of an fCash position.
     * If sendToken is a registered fCash position it redeems it, if the receiveToken is an fCash position it mints it.
     * The respective other token must be either the underlying or asset token of the fCash position.
     * Reverts if send and receive token are not a combination of 1 registered fCash position and its underlying or asset token.
     * @param _setToken                     Instance of the SetToken
     * @param _sendToken                    Address of the token to trade out of ("sell")
     * @param _sendAmount                 Amount of send token to sell. (Fixed amount in the redeem case and max amount in mint case);
     * @param _receiveToken                  Address of the token to trade in to ("buy")
     * @param _receiveAmount              Amount of receive token to buy. (Fixed amount in the mint case and min amount in redeem case);
     */
    function trade(
        ISetToken _setToken,
        address _sendToken,
        uint256 _sendAmount,
        address _receiveToken,
        uint256 _receiveAmount
    )
        external
        nonReentrant
        onlyManagerAndValidSet(_setToken)
        returns(uint256)
    {
        if(fCashPositions[_setToken].contains(_sendToken))
        {
            return _redeemFCashPosition(_setToken, IWrappedfCashComplete(_sendToken), IERC20(_receiveToken), _sendAmount, _receiveAmount);
        }
        else if(fCashPositions[_setToken].contains(_receiveToken))
        {
            return _mintFCashPosition(_setToken, IWrappedfCashComplete(_receiveToken), IERC20(_sendToken), _receiveAmount, _sendAmount);
        }
        else {
            revert("Neither send nor receive token is a registered fCash position");
        }

    }

    /**
     * @dev CALLABLE BY ANYBODY: Redeem all matured fCash positions of given setToken
     * Redeem all fCash positions that have reached maturity for their asset token (cToken)
     * This will update the set tokens components and positions (removes matured fCash positions and creates / increases positions of the asset token).
     * @param _setToken                     Instance of the SetToken
     */
    function redeemMaturedPositions(ISetToken _setToken) public nonReentrant onlyValidAndInitializedSet(_setToken) {
        _redeemMaturedPositions(_setToken);
    }

    /**
     * @dev MANGER ONLY: Initialize given SetToken with initial list of registered fCash positions
     * Redeem all fCash positions that have reached maturity for their asset token (cToken)
     * @param _setToken                     Instance of the SetToken
     * @param _fCashPositions               WrappedFCash tokens to register for trading and maturity monitoring. (this will NOT add these components to the set)
     */
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

    /**
     * @dev Hook called once before setToken issuance
     * @dev Ensures that no matured fCash positions are in the set when it is issued
     */
    function moduleIssueHook(ISetToken _setToken, uint256 /* _setTokenAmount */) external override onlyModule(_setToken) {
        _redeemMaturedPositions(_setToken);
    }

    /**
     * @dev Hook called once before setToken redemption
     * @dev Ensures that no matured fCash positions are in the set when it is redeemed
     */
    function moduleRedeemHook(ISetToken _setToken, uint256 /* _setTokenAmount */) external override onlyModule(_setToken) {
        _redeemMaturedPositions(_setToken);
    }


    /**
     * @dev Hook called once for each component upon setToken issuance
     * @dev Empty method added to satisfy IModuleIssuanceHook interface
     */
    function componentIssueHook(
        ISetToken _setToken,
        uint256 _setTokenAmount,
        IERC20 _component,
        bool _isEquity
    ) external override onlyModule(_setToken) {
    }

    /**
     * @dev Hook called once for each component upon setToken redemption
     * @dev Empty method added to satisfy IModuleIssuanceHook interface
     */
    function componentRedeemHook(
        ISetToken _setToken,
        uint256 _setTokenAmount,
        IERC20 _component,
        bool _isEquity
    ) external override onlyModule(_setToken) {
    }




    /* ============ External Getter Functions ============ */

    /**
     * @dev Get array of registered fCash positions
     * @param _setToken             Instance of the SetToken
     */
    function getFCashPositions(ISetToken _setToken)
    external
    view
    returns(address[] memory positions)
    {
        uint256 length = fCashPositions[_setToken].length();
        positions = new address[](length);
        for(uint256 i = 0; i < length; i++) {
            positions[i] = fCashPositions[_setToken].at(i);
        }
    }

    /* ============ Internal Functions ============ */

    /**
     * @dev Redeem all matured fCash positions for the given SetToken
     */
    function _redeemMaturedPositions(ISetToken _setToken)
    internal
    {
        uint fCashPositionLength = fCashPositions[_setToken].length();
        if(fCashPositionLength == 0) return;

        bool toUnderlying = redeemToUnderlying[_setToken];


        for(uint256 i = 0; i < fCashPositionLength; i++) {
            IWrappedfCashComplete fCashPosition = IWrappedfCashComplete(fCashPositions[_setToken].at(i));

            if(fCashPosition.hasMatured()) {
                IERC20 receiveToken = _getPaymentToken(fCashPosition, toUnderlying);
                uint256 fCashBalance = fCashPosition.balanceOf(address(_setToken));
                _redeemFCashPosition(_setToken, fCashPosition, receiveToken, fCashBalance, 0);
            }

        }

    }



    /**
     * @dev Redeem a given fCash position from the specified send token (either underlying or asset token)
     * @dev Alo adjust the components / position of the set token accordingly
     */
    function _mintFCashPosition(
        ISetToken _setToken,
        IWrappedfCashComplete _fCashPosition,
        IERC20 _sendToken,
        uint256 _fCashAmount,
        uint256 _maxSendAmount
    )
    internal
    returns(uint256 sentAmount)
    {
        if(_fCashAmount == 0) return 0;

        bool fromUnderlying = _isUnderlying(_fCashPosition, _sendToken);


        _approveIfNecessary(_setToken, _fCashPosition, _sendToken, _maxSendAmount);

        uint256 preTradeSendTokenBalance = _sendToken.balanceOf(address(_setToken));
        uint256 preTradeReceiveTokenBalance = _fCashPosition.balanceOf(address(_setToken));

        _mint(_setToken, _fCashPosition, _maxSendAmount, _fCashAmount, fromUnderlying);


        (sentAmount,) = _updateSetTokenPositions(
            _setToken,
            address(_sendToken),
            preTradeSendTokenBalance,
            address(_fCashPosition),
            preTradeReceiveTokenBalance
        );

        require(sentAmount <= _maxSendAmount, "Overpaid");
        emit FCashMinted(_setToken, _fCashPosition, _sendToken, _fCashAmount, sentAmount);
    }

    /**
     * @dev Redeem a given fCash position for the specified receive token (either underlying or asset token)
     * @dev Alo adjust the components / position of the set token accordingly
     */
    function _redeemFCashPosition(
        ISetToken _setToken,
        IWrappedfCashComplete _fCashPosition,
        IERC20 _receiveToken,
        uint256 _fCashAmount,
        uint256 _minReceiveAmount
    )
    internal
    returns(uint256 receivedAmount)
    {
        if(_fCashAmount == 0) return 0;

        bool toUnderlying = _isUnderlying(_fCashPosition, _receiveToken);
        uint256 preTradeReceiveTokenBalance = _receiveToken.balanceOf(address(_setToken));
        uint256 preTradeSendTokenBalance = _fCashPosition.balanceOf(address(_setToken));

        _redeem(_setToken, _fCashPosition, _fCashAmount, toUnderlying);


        (, receivedAmount) = _updateSetTokenPositions(
            _setToken,
            address(_fCashPosition),
            preTradeSendTokenBalance,
            address(_receiveToken),
            preTradeReceiveTokenBalance
        );


        require(receivedAmount >= _minReceiveAmount, "Not enough received amount");
        emit FCashRedeemed(_setToken, _fCashPosition, _receiveToken, _fCashAmount, receivedAmount);

    }

    /**
     * @dev Approve the given wrappedFCash instance to spend the setToken's sendToken 
     */
    function _approveIfNecessary(
        ISetToken _setToken,
        IWrappedfCashComplete _fCashPosition,
        IERC20 _sendToken,
        uint256 _maxAssetAmount
    )
    internal
    {
        if(IERC20(_sendToken).allowance(address(_setToken), address(_fCashPosition)) < _maxAssetAmount) {
            // TODO: Review if we want to only approve "_maxAssetAmount" or keep it at maxUint256
            bytes memory approveCallData = abi.encodeWithSignature("approve(address,uint256)", address(_fCashPosition), type(uint256).max);
            _setToken.invoke(address(_sendToken), 0, approveCallData);
        }
    }

    /**
     * @dev Invokes the wrappedFCash token's mint function from the setToken
     */
    function _mint(
        ISetToken _setToken,
        IWrappedfCashComplete _fCashPosition,
        uint256 _maxAssetAmount,
        uint256 _fCashAmount,
        bool _fromUnderlying
    )
    internal
    {
        // TODO: Review if this value is correct / what is min implied rate ? 
        uint32 minImpliedRate = 0;

        string memory functionSignature =  
            _fromUnderlying ? "mintViaUnderlying(uint256,uint88,address,uint32)": "mintViaAsset(uint256,uint88,address,uint32)";
        bytes memory mintCallData = abi.encodeWithSignature(
            functionSignature,
            _maxAssetAmount,
            uint88(_fCashAmount),
            address(_setToken),
            minImpliedRate,
            _fromUnderlying
        );
        _setToken.invoke(address(_fCashPosition), 0, mintCallData);
    }

    /**
     * @dev Redeems the given amount of fCash token on behalf of the setToken
     */
    function _redeem(
        ISetToken _setToken,
        IWrappedfCashComplete _fCashPosition,
        uint256 _fCashAmount,
        bool _toUnderlying
    )
    internal
    {
        // TODO: Review if this value is correct / what is max implied rate ? 
        uint32 maxImpliedRate = type(uint32).max;

        string memory functionSignature =  
            _toUnderlying ? "redeemToUnderlying(uint256,address,uint32)": "redeemToAsset(uint256,address,uint32)";
        bytes memory redeemCallData = abi.encodeWithSignature(
            functionSignature,
            _fCashAmount,
            address(_setToken),
            maxImpliedRate
        );
        _setToken.invoke(address(_fCashPosition), 0, redeemCallData);
    }

    /**
     * @dev Returns boolean indicating if given paymentToken is the underlying of the given fCashPosition
     * @dev Reverts if given token is neither underlying nor asset token of the fCashPosition
     */
    function _isUnderlying(
        IWrappedfCashComplete _fCashPosition,
        IERC20 _paymentToken
    )
    internal
    view
    returns(bool isUnderlying)
    {
        (IERC20 underlyingToken, IERC20 assetToken) = _getUnderlyingAndAssetTokens(_fCashPosition);
        isUnderlying = _paymentToken == underlyingToken;
        if(!isUnderlying) {
            require(_paymentToken == assetToken, "Token is neither asset nor underlying token");
        }
    }

    /**
     * @dev Returns underlying or asset token address for given fCashPosition based on _getUnderlying flag
     */
    function _getPaymentToken(
        IWrappedfCashComplete _fCashPosition,
        bool _getUnderlying
    )
    internal
    view
    returns(IERC20 paymentToken)
    {
        (IERC20 underlyingToken, IERC20 assetToken) = _getUnderlyingAndAssetTokens(_fCashPosition);
         paymentToken = _getUnderlying ? underlyingToken : assetToken;
    }

    /**
     * @dev Returns both underlying and asset token address for given fCash position
     */
    function _getUnderlyingAndAssetTokens(IWrappedfCashComplete _fCashPosition)
    internal
    view
    returns(IERC20 underlyingToken, IERC20 assetToken)
    {
        (underlyingToken,) = _fCashPosition.getUnderlyingToken();
        (assetToken,,) = _fCashPosition.getAssetToken();
    }


    /**
     * @dev Register given fCash positions to enable them to be traded and have them monitored for maturity redemption
     */
    function _addFCashPositions(ISetToken _setToken, address[] calldata _fCashPositions) internal {
        for(uint256 i = 0; i < _fCashPositions.length; i++) {
            fCashPositions[_setToken].add(_fCashPositions[i]);
        }
    }

    /**
     * @dev Update set token positions after mint or redeem
     * @dev WARNING: This function is largely copied from the trade module
     */
    function _updateSetTokenPositions(
        ISetToken setToken,
        address sendToken,
        uint256 preTradeSendTokenBalance,
        address receiveToken,
        uint256 preTradeReceiveTokenBalance
    ) internal returns (uint256, uint256) {

        uint256 setTotalSupply = setToken.totalSupply();

        // This reverts if i try to trade a token that is not a registered component. (I.e. I just sent a lot of sendToken to the contract manually and then try to trade it.
        // TODO: Review if this needs to be addressed
        (uint256 currentSendTokenBalance,,) = setToken.calculateAndEditDefaultPosition(
            sendToken,
            setTotalSupply,
            preTradeSendTokenBalance
        );

        (uint256 currentReceiveTokenBalance,,) = setToken.calculateAndEditDefaultPosition(
            receiveToken,
            setTotalSupply,
            preTradeReceiveTokenBalance
        );

        return (
            preTradeSendTokenBalance.sub(currentSendTokenBalance),
            currentReceiveTokenBalance.sub(preTradeReceiveTokenBalance)
        );

    }
}
