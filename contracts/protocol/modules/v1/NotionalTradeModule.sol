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
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Address } from "@openzeppelin/contracts/utils/Address.sol";

import { IController } from "../../../interfaces/IController.sol";
import { IDebtIssuanceModule } from "../../../interfaces/IDebtIssuanceModule.sol";
import { IModuleIssuanceHook } from "../../../interfaces/IModuleIssuanceHook.sol";
import { IWrappedfCashComplete } from "../../../interfaces/IWrappedFCash.sol";
import { IWrappedfCashFactory } from "../../../interfaces/IWrappedFCashFactory.sol";
import { INotionalV2 } from "../../../interfaces/external/INotionalV2.sol";
import { ISetToken } from "../../../interfaces/ISetToken.sol";
import { ModuleBase } from "../../lib/ModuleBase.sol";
import { Position } from "../../lib/Position.sol";



/**
 * @title NotionalTradeModule
 * @author Set Protocol
 * @notice Smart contract that enables trading in and out of Notional fCash positions and redeem matured positions.
 * @dev This module depends on the wrappedFCash erc20-token-wrapper. Meaning positions managed with this module have to be in the form of wrappedfCash NOT fCash directly.
 */
contract NotionalTradeModule is ModuleBase, ReentrancyGuard, Ownable, IModuleIssuanceHook {
    using Address for address;

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

    // Mapping to save set tokens for which automatic redeeming of underlying tokens upon maturity has been disabled
    mapping(ISetToken => bool) public redemptionHookDisabled;

    // Mapping for a set token, whether or not to redeem to underlying upon reaching maturity
    mapping(ISetToken => bool) public redeemToUnderlying;

    // Mapping of SetToken to boolean indicating if SetToken is on allow list. Updateable by governance
    mapping(ISetToken => bool) public allowedSetTokens;

    // Boolean that returns if any SetToken can initialize this module. If false, then subject to allow list. Updateable by governance.
    bool public anySetAllowed;

    // Factory that is used to deploy and check fCash wrapper contracts
    IWrappedfCashFactory public immutable wrappedfCashFactory;
    IERC20 public immutable weth;
    INotionalV2 public immutable notionalV2;

    uint256 public decodedIdGasLimit;


    /* ============ Constructor ============ */

    /**
     * @dev Instantiate addresses
     * @param _controller                       Address of controller contract
     * @param _wrappedfCashFactory              Address of fCash wrapper factory used to check and deploy wrappers
     * @param _weth                             Weth token address
     * @param _notionalV2                       Address of the notionalV2 proxy contract
     * @param _decodedIdGasLimit                Gas limit for call to getDecodedID
     */
    constructor(
        IController _controller,
        IWrappedfCashFactory _wrappedfCashFactory,
        IERC20 _weth,
        INotionalV2 _notionalV2,
        uint256 _decodedIdGasLimit
    )
        public
        ModuleBase(_controller)
    {
        require(address(_wrappedfCashFactory) != address(0), "WrappedfCashFactory address cannot be zero");
        wrappedfCashFactory = _wrappedfCashFactory;

        require(address(_weth) != address(0), "Weth address cannot be zero");
        weth = _weth;

        require(address(_notionalV2) != address(0), "NotionalV2 address cannot be zero");
        notionalV2 = _notionalV2;

        decodedIdGasLimit = _decodedIdGasLimit;
    }

    /* ============ External Functions ============ */


    /**
     * @dev MANAGER ONLY: Trades into a new fCash position.
     * @param _setToken                   Instance of the SetToken
     * @param _currencyId                 CurrencyId of the fCash token as defined by the notional protocol. 
     * @param _maturity                   Maturity of the fCash token as defined by the notional protocol.
     * @param _mintAmount                 Amount of fCash token to mint 
     * @param _sendToken                  Token to mint from, must be either the underlying or the asset token.
     * @param _maxSendAmount              Maximum amount to spend
     * @return Amount of sendToken spent
     */
    function mintFixedFCashForToken(
        ISetToken _setToken,
        uint16 _currencyId,
        uint40 _maturity,
        uint256 _mintAmount,
        address _sendToken,
        uint256 _maxSendAmount
    )
        external
        nonReentrant
        onlyManagerAndValidSet(_setToken)
        returns(uint256)
    {
        require(_setToken.isComponent(_sendToken), "Send token must be an index component");
        require(
            _setToken.hasSufficientDefaultUnits(_sendToken, _maxSendAmount),
            "Insufficient sendToken position"
        );

        (uint256 totalMintAmount, uint256 totalMaxSendAmount) = _calculateTotalAmounts(_setToken, _mintAmount, _maxSendAmount);

        IWrappedfCashComplete wrappedfCash = _deployWrappedfCash(_currencyId, _maturity);
        bool isUnderlying = _isUnderlying(wrappedfCash, IERC20(_sendToken));

        return _mintFCashPosition(_setToken, wrappedfCash, IERC20(_sendToken), totalMintAmount, totalMaxSendAmount, isUnderlying);
    }

    /**
     * @dev MANAGER ONLY: Mints a fixed amount of send tokens worth of fCash
     * @param _setToken                   Instance of the SetToken
     * @param _currencyId                 CurrencyId of the fCash token as defined by the notional protocol. 
     * @param _maturity                   Maturity of the fCash token as defined by the notional protocol.
     * @param _minMintAmount              Minimum amount of fCash token to mint
     * @param _sendToken                  Token to mint from, must be either the underlying or the asset token.
     * @param _sendAmount                 Amount of input/asset tokens to convert to fCash
     * @return Amount of sendToken spent
     */
    function mintFCashForFixedToken(
        ISetToken _setToken,
        uint16 _currencyId,
        uint40 _maturity,
        uint256 _minMintAmount,
        address _sendToken,
        uint256 _sendAmount
    )
        external
        nonReentrant
        onlyManagerAndValidSet(_setToken)
        returns(uint256)
    {
        require(_setToken.isComponent(_sendToken), "Send token must be an index component");
        require(
            _setToken.hasSufficientDefaultUnits(_sendToken, _sendAmount),
            "Insufficient sendToken position"
        );

        (uint256 totalMinMintAmount, uint256 totalSendAmount) = _calculateTotalAmounts(_setToken, _minMintAmount, _sendAmount);

        IWrappedfCashComplete wrappedfCash = _deployWrappedfCash(_currencyId, _maturity);

        bool isUnderlying = _isUnderlying(wrappedfCash, IERC20(_sendToken));

        (uint88 totalMintAmount,,) = notionalV2.getfCashLendFromDeposit(_currencyId, totalSendAmount, _maturity, 0, block.timestamp, isUnderlying);
        require(totalMinMintAmount <= uint256(totalMintAmount), "Insufficient mint amount");
 
        return _mintFCashPosition(_setToken, wrappedfCash, IERC20(_sendToken), uint256(totalMintAmount), totalSendAmount, isUnderlying);
    }

    /**
     * @dev MANAGER ONLY: Redeems a fixed amount of fCash position for a minimum position of receiving token
     * Will revert if no wrapper for the selected fCash token was deployed
     * @param _setToken                   Instance of the SetToken
     * @param _currencyId                 CurrencyId of the fCash token as defined by the notional protocol. 
     * @param _maturity                   Maturity of the fCash token as defined by the notional protocol.
     * @param _redeemAmount               Amount of fCash token to redeem  per Set Token
     * @param _receiveToken               Token to redeem into, must be either asset or underlying token of the fCash token
     * @param _minReceiveAmount           Minimum amount of receive token to receive per Set Token
     * @return Amount of receiveToken received
     */
    function redeemFixedFCashForToken(
        ISetToken _setToken,
        uint16 _currencyId,
        uint40 _maturity,
        uint256 _redeemAmount,
        address _receiveToken,
        uint256 _minReceiveAmount
    )
        external
        nonReentrant
        onlyManagerAndValidSet(_setToken)
        returns(uint256)
    {
        IWrappedfCashComplete wrappedfCash = _getWrappedfCash(_currencyId, _maturity);
        require(_setToken.isComponent(address(wrappedfCash)), "FCash to redeem must be an index component");

        require(
            _setToken.hasSufficientDefaultUnits(address(wrappedfCash), _redeemAmount),
            "Insufficient fCash position"
        );
        (uint256 totalRedeemAmount, uint256 totalMinReceiveAmount) = _calculateTotalAmounts(_setToken, _redeemAmount, _minReceiveAmount);
        bool isUnderlying = _isUnderlying(wrappedfCash, IERC20(_receiveToken));

        return _redeemFCashPosition(_setToken, wrappedfCash, IERC20(_receiveToken), totalRedeemAmount, totalMinReceiveAmount, isUnderlying);
    }


    /**
     * @dev MANAGER ONLY: Redeems the required amount of the fCash position to receive a fixed amount of receive tokens
     * Will revert if no wrapper for the selected fCash token was deployed
     * @param _setToken                   Instance of the SetToken
     * @param _currencyId                 CurrencyId of the fCash token as defined by the notional protocol. 
     * @param _maturity                   Maturity of the fCash token as defined by the notional protocol.
     * @param _maxRedeemAmount            Maximum amount of fCash to redeem
     * @param _receiveToken               Token to redeem into, must be either asset or underlying token of the fCash token
     * @param _receiveAmount              Amount of receive tokens to receive
     * @param _maxReceiveAmountDeviation  Relative deviation in 18 decimals to allow between the specified receive amount and actual.
     * @return Amount of receiveToken received
     */
    function redeemFCashForFixedToken(
        ISetToken _setToken,
        uint16 _currencyId,
        uint40 _maturity,
        uint256 _maxRedeemAmount,
        address _receiveToken,
        uint256 _receiveAmount,
        uint256 _maxReceiveAmountDeviation
    )
        external
        nonReentrant
        onlyManagerAndValidSet(_setToken)
        returns(uint256)
    {
        IWrappedfCashComplete wrappedfCash = _getWrappedfCash(_currencyId, _maturity);
        require(_setToken.isComponent(address(wrappedfCash)), "FCash to redeem must be an index component");

        require(
            _setToken.hasSufficientDefaultUnits(address(wrappedfCash), _maxRedeemAmount),
            "Insufficient fCash position"
        );
        (uint256 totalMaxRedeemAmount, uint256 totalReceiveAmount) = _calculateTotalAmounts(_setToken, _maxRedeemAmount, _receiveAmount);

        bool isUnderlying = _isUnderlying(wrappedfCash, IERC20(_receiveToken));
        (uint88 totalRedeemAmount,,) = notionalV2.getfCashBorrowFromPrincipal(_currencyId, totalReceiveAmount, _maturity, 0, block.timestamp, isUnderlying);
        require(totalMaxRedeemAmount >= uint256(totalRedeemAmount), "Excessive redeem amount");

        // This tolerance is necessary to account for rouding / approximation error in getfCashBorrowFromPrincipal
        totalReceiveAmount = totalReceiveAmount.sub(totalReceiveAmount.mul(_maxReceiveAmountDeviation).div(1 ether));

        return _redeemFCashPosition(_setToken, wrappedfCash, IERC20(_receiveToken), totalRedeemAmount, totalReceiveAmount, isUnderlying);
    }


    /**
     * @dev CALLABLE BY ANYBODY: Redeem all matured fCash positions of given setToken
     * Redeem all fCash positions that have reached maturity for their asset token (cToken) or underlyintToken if configured accordingly by the manager.
     * This will update the set tokens components and positions (removes matured fCash positions and creates / increases positions of the asset token).
     * @param _setToken                     Instance of the SetToken
     */
    function redeemMaturedPositions(ISetToken _setToken) external nonReentrant onlyValidAndInitializedSet(_setToken) {
        _redeemMaturedPositions(_setToken);
    }

    /**
     * @dev MANAGER ONLY: Initialize given SetToken with initial list of registered fCash positions
     * @param _setToken                     Instance of the SetToken
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
        require(_setToken.isInitializedModule(getAndValidateAdapter(DEFAULT_ISSUANCE_MODULE_NAME)), "Issuance not initialized");

        // Try if register exists on any of the modules including the debt issuance module
        address[] memory modules = _setToken.getModules();
        for(uint256 i = 0; i < modules.length; ++i) {
            if(modules[i].isContract()){
                try IDebtIssuanceModule(modules[i]).registerToIssuanceModule(_setToken) {} catch {}
            }
        }
    }

    /**
     * @dev MANAGER ONLY: Removes this module from the SetToken, via call by the SetToken. Redeems any matured positions unless this function is disabled by the manager.
     */
    function removeModule() external override onlyValidAndInitializedSet(ISetToken(msg.sender)) {
        ISetToken setToken = ISetToken(msg.sender);

        // Redeem matured positions prior to any removal action
        if(!redemptionHookDisabled[setToken]) {
            _redeemMaturedPositions(setToken);
        }

        // Try if unregister exists on any of the modules
        address[] memory modules = setToken.getModules();
        for(uint256 i = 0; i < modules.length; ++i) {
            if(modules[i].isContract()){
                try IDebtIssuanceModule(modules[i]).unregisterFromIssuanceModule(setToken) {} catch {}
            }
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
     * @dev MANAGER ONLY: Dis-/Enable automatic redemption of matured positions
     * @param _setToken             Instance of the SetToken
     * @param _isDisabled           Bool indicating wether to disable 
     */
    function updateRedemptionHookDisabled(ISetToken _setToken, bool _isDisabled) external onlyManagerAndValidSet(_setToken) {
        redemptionHookDisabled[_setToken] = _isDisabled;
    }

    /**
     * @dev GOVERNANCE ONLY: Update gas limit of call to getDecodedID in _isWrappedFCash
     * @param _decodedIdGasLimit   New gas limit for call to getDecodedID
     */
    function updateDecodedIdGasLimit(uint256 _decodedIdGasLimit) external onlyOwner {
        require(_decodedIdGasLimit != 0, "DecodedIdGasLimit cannot be zero");
        decodedIdGasLimit = _decodedIdGasLimit;
    }

    /**
     * @dev GOVERNANCE ONLY: Enable/disable ability of a SetToken to initialize this module. Only callable by governance.
     * @param _setToken             Instance of the SetToken
     * @param _isAllowed            Bool indicating if _setToken is allowed to initialize this module
     */
    function updateAllowedSetToken(ISetToken _setToken, bool _isAllowed) external onlyOwner {
        require(controller.isSet(address(_setToken)) || allowedSetTokens[_setToken], "Invalid SetToken");
        allowedSetTokens[_setToken] = _isAllowed;
        emit SetTokenStatusUpdated(_setToken, _isAllowed);
    }

    /**
     * @dev GOVERNANCE ONLY: Toggle whether ANY SetToken is allowed to initialize this module. Only callable by governance.
     * @param _anySetAllowed             Bool indicating if ANY SetToken is allowed to initialize this module
     */
    function updateAnySetAllowed(bool _anySetAllowed) external onlyOwner {
        anySetAllowed = _anySetAllowed;
        emit AnySetAllowedUpdated(_anySetAllowed);
    }

    function setRedeemToUnderlying(
        ISetToken _setToken,
        bool _toUnderlying
    )
    external
    onlyManagerAndValidSet(_setToken)
    {
        redeemToUnderlying[_setToken] = _toUnderlying;
    }


    /**
     * @dev Hook called once before setToken issuance
     * @dev Ensures that no matured fCash positions are in the set when it is issued unless automatic redemption is disabled
     * @param _setToken             Instance of the SetToken
     */
    function moduleIssueHook(ISetToken _setToken, uint256 /* _setTokenAmount */) external override onlyModule(_setToken) {
        if(!redemptionHookDisabled[_setToken]) {
            _redeemMaturedPositions(_setToken);
        }
    }

    /**
     * @dev Hook called once before setToken redemption
     * @dev Ensures that no matured fCash positions are in the set when it is redeemed unless automatic redemption is disabled
     * @param _setToken             Instance of the SetToken
     */
    function moduleRedeemHook(ISetToken _setToken, uint256 /* _setTokenAmount */) external override onlyModule(_setToken) {
        if(!redemptionHookDisabled[_setToken]) {
            _redeemMaturedPositions(_setToken);
        }
    }


    /**
     * @dev Hook called once for each component upon setToken issuance
     * @dev Empty method added to satisfy IModuleIssuanceHook interface
     * @param _setToken             Instance of the SetToken
     */
    function componentIssueHook(
        ISetToken _setToken,
        uint256 /* _setTokenAmount */,
        IERC20 /* _component */,
        bool /* _isEquity */
    ) external override onlyModule(_setToken) {
    }

    /**
     * @dev Hook called once for each component upon setToken redemption
     * @dev Empty method added to satisfy IModuleIssuanceHook interface
     * @param _setToken             Instance of the SetToken
     */
    function componentRedeemHook(
        ISetToken _setToken,
        uint256 /* _setTokenAmount */,
        IERC20 /* _component */,
        bool /* _isEquity */
    ) external override onlyModule(_setToken) {
    }




    /* ============ External Getter Functions ============ */

    /**
     * @dev Get array of registered fCash components
     * @param _setToken             Instance of the SetToken
     * @return fCashComponents      Array of addresses that correspond to components that are wrapped fCash tokens
     */
    function getFCashComponents(ISetToken _setToken)
    external
    view
    returns(address[] memory fCashComponents)
    {
        ISetToken.Position[] memory positions = _setToken.getPositions();
        address[] memory temp = new address[](positions.length);
        uint positionsLength = positions.length;
        uint numFCashPositions;

        for(uint256 i = 0; i < positionsLength; ++i) {
            // Check that the given position is an equity position
            if(positions[i].unit > 0) {
                address component = positions[i].component;
                if(_isWrappedFCash(component)) {
                    temp[numFCashPositions] = component;
                    ++numFCashPositions;
                }
            }
        }

        fCashComponents = new address[](numFCashPositions);
        for(uint256 i = 0; i < numFCashPositions; ++i) {
            fCashComponents[i] = temp[i];
        }
    }

    /* ============ Internal Functions ============ */


    /**
     * @dev Deploy wrapper if it does not exist yet and return address
     */
    function _deployWrappedfCash(uint16 _currencyId, uint40 _maturity) internal returns(IWrappedfCashComplete) {
        address wrappedfCashAddress = wrappedfCashFactory.deployWrapper(_currencyId, _maturity);
        return IWrappedfCashComplete(wrappedfCashAddress);
    }
     
    /**
     * @dev Return wrapper address and revert if it isn't deployed
     */
    function _getWrappedfCash(uint16 _currencyId, uint40 _maturity) internal view returns(IWrappedfCashComplete) {
        address wrappedfCashAddress = wrappedfCashFactory.computeAddress(_currencyId, _maturity);
        require(wrappedfCashAddress.isContract(), "WrappedfCash not deployed for given parameters");
        return IWrappedfCashComplete(wrappedfCashAddress);
    }

    /**
     * @dev Calculate total amounts to to trade based on positional amounts and set tokens total supply
     *
     */
    function _calculateTotalAmounts(
        ISetToken _setToken,
        uint256 _fCashAmount,
        uint256 _paymentTokenAmount
    )
        internal
        view
        returns (uint256, uint256)
    {
        uint256 setTotalSupply = _setToken.totalSupply();
        uint256 totalfCashAmount = Position.getDefaultTotalNotional(setTotalSupply, _fCashAmount);
        uint256 totalpaymentTokenAmount = Position.getDefaultTotalNotional(setTotalSupply, _paymentTokenAmount);

        return (totalfCashAmount, totalpaymentTokenAmount);
    }

    /**
     * @dev Redeem all matured fCash positions for the given SetToken
     */
    function _redeemMaturedPositions(ISetToken _setToken)
    internal
    {
        ISetToken.Position[] memory positions = _setToken.getPositions();
        uint positionsLength = positions.length;

        bool toUnderlying = redeemToUnderlying[_setToken];

        for(uint256 i = 0; i < positionsLength; ++i) {
            // Check that the given position is an equity position
            if(positions[i].unit > 0) {
                address component = positions[i].component;
                if(_isWrappedFCash(component)) {
                    IWrappedfCashComplete fCashPosition = IWrappedfCashComplete(component);
                    if(fCashPosition.hasMatured()) {
                        (IERC20 receiveToken, bool isEth) = fCashPosition.getToken(toUnderlying);
                        if(isEth) {
                            receiveToken = weth;
                        }

                        uint256 setTotalSupply = _setToken.totalSupply();
                        uint256 totalfCashAmount = Position.getDefaultTotalNotional(setTotalSupply, uint256(positions[i].unit));

                        _redeemFCashPosition(_setToken, fCashPosition, receiveToken, totalfCashAmount, 0, toUnderlying);
                    }
                }
            }
        }
    }



    /**
     * @dev Mint a given fCash position from the specified send token (either underlying or asset token)
     * @dev Will adjust the components / position of the set token accordingly
     */
    function _mintFCashPosition(
        ISetToken _setToken,
        IWrappedfCashComplete _fCashPosition,
        IERC20 _sendToken,
        uint256 _fCashAmount,
        uint256 _maxSendAmount,
        bool _fromUnderlying
    )
    internal
    returns(uint256 sentAmount)
    {
        if(_fCashAmount == 0) return 0;

        _approve(_setToken, _fCashPosition, _sendToken, _maxSendAmount);

        uint256 preTradeSendTokenBalance = _sendToken.balanceOf(address(_setToken));
        uint256 preTradeReceiveTokenBalance = _fCashPosition.balanceOf(address(_setToken));

        _mint(_setToken, _fCashPosition, _maxSendAmount, _fCashAmount, _fromUnderlying);


        (sentAmount,) = _updateSetTokenPositions(
            _setToken,
            address(_sendToken),
            preTradeSendTokenBalance,
            address(_fCashPosition),
            preTradeReceiveTokenBalance
        );
        require(sentAmount <= _maxSendAmount, "Overspent");


        _resetAllowance(_setToken, _fCashPosition, _sendToken);
        emit FCashMinted(_setToken, _fCashPosition, _sendToken, _fCashAmount, sentAmount);
    }

    /**
     * @dev Redeem a given fCash position for the specified receive token (either underlying or asset token)
     * @dev Will adjust the components / position of the set token accordingly
     */
    function _redeemFCashPosition(
        ISetToken _setToken,
        IWrappedfCashComplete _fCashPosition,
        IERC20 _receiveToken,
        uint256 _fCashAmount,
        uint256 _minReceiveAmount,
        bool _toUnderlying
    )
    internal
    returns(uint256 receivedAmount)
    {
        if(_fCashAmount == 0) return 0;

        uint256 preTradeReceiveTokenBalance = _receiveToken.balanceOf(address(_setToken));
        uint256 preTradeSendTokenBalance = _fCashPosition.balanceOf(address(_setToken));

        _redeem(_setToken, _fCashPosition, _fCashAmount, _toUnderlying);


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
    function _approve(
        ISetToken _setToken,
        IWrappedfCashComplete _fCashPosition,
        IERC20 _sendToken,
        uint256 _maxAssetAmount
    )
    internal
    {
        if(IERC20(_sendToken).allowance(address(_setToken), address(_fCashPosition)) < _maxAssetAmount) {
            bytes memory approveCallData = abi.encodeWithSelector(_sendToken.approve.selector, address(_fCashPosition), _maxAssetAmount);
            _setToken.invoke(address(_sendToken), 0, approveCallData);
        }
    }

    /**
     * @dev Resets allowance to zero to avoid residual allowances
     */
    function _resetAllowance(
        ISetToken _setToken,
        IWrappedfCashComplete _fCashPosition,
        IERC20 _sendToken
    )
    internal
    {
        bytes memory approveCallData = abi.encodeWithSelector(_sendToken.approve.selector, address(_fCashPosition), 0);
        _setToken.invoke(address(_sendToken), 0, approveCallData);
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
        bytes4 functionSelector = 
            _fromUnderlying ? _fCashPosition.mintViaUnderlying.selector : _fCashPosition.mintViaAsset.selector;
        bytes memory mintCallData = abi.encodeWithSelector(
            functionSelector,
            _maxAssetAmount,
            _safeUint88(_fCashAmount),
            address(_setToken),
            0
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
        bytes4 functionSelector =
            _toUnderlying ? _fCashPosition.redeemToUnderlying.selector : _fCashPosition.redeemToAsset.selector;
        bytes memory redeemCallData = abi.encodeWithSelector(
            functionSelector,
            _fCashAmount,
            address(_setToken),
            type(uint32).max
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
     * @dev Returns both underlying and asset token address for given fCash position
     */
    function _getUnderlyingAndAssetTokens(IWrappedfCashComplete _fCashPosition)
    internal
    view
    returns(IERC20, IERC20)
    {
        (IERC20 underlyingToken, bool isEth) = _fCashPosition.getToken(true);
        if(isEth) {
            underlyingToken = weth;
        }
        (IERC20 assetToken, ) = _fCashPosition.getToken(false);
        return(underlyingToken, assetToken);
    }

    /**
     * @dev Checks if a given address is a fCash position that was deployed from the factory
     */
    function _isWrappedFCash(address _fCashPosition) internal view returns(bool){
        if(!_fCashPosition.isContract()) {
            return false;
        }

        // Added this gas limit, since the fallback funciton on cEth consumes an extremely high amount of gas
        try IWrappedfCashComplete(_fCashPosition).getDecodedID{gas: decodedIdGasLimit}() returns(uint16 _currencyId, uint40 _maturity){
            try wrappedfCashFactory.computeAddress(_currencyId, _maturity) returns(address _computedAddress){
                return _fCashPosition == _computedAddress;
            } catch {
                return false;
            }
        } catch {
            return false;
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

    /**
     * @dev Safe downcast from uint256 to uint88
     */
    function _safeUint88(uint256 x) internal view returns (uint88) {
        require(x <= uint256(type(uint88).max), "Uint88 downcast: overflow");
        return uint88(x);
    }

}
