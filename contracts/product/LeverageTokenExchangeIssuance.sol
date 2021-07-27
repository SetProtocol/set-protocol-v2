pragma solidity 0.6.10;
pragma experimental "ABIEncoderV2";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { IAaveLendingPool } from "../interfaces/external/IAaveLendingPool.sol";
import { ICErc20 } from "../interfaces/external/ICErc20.sol";
import { ICEth } from "../interfaces/external/ICEth.sol";
import { IFlashLoanReceiver } from "../interfaces/external/IFlashLoanReceiver.sol";
import { ILeverageModule } from "../interfaces/ILeverageModule.sol";
import { IDebtIssuanceModule } from "../interfaces/IDebtIssuanceModule.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IUniswapV2Router } from "../interfaces/external/IUniswapV2Router.sol";
import { IWETH } from "../interfaces/external/IWETH.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";

import { console } from "hardhat/console.sol";

contract LeverageTokenExchangeIssuance is IFlashLoanReceiver {
    using SafeERC20 for IERC20;
    using SafeMath for uint256;
    using PreciseUnitMath for uint256;

    /* =========== ENUMS ============ */

    enum TradeType { EXACT_OUTPUT_ISSUE, EXACT_INPUT_REDEEM }

    /* =========== Structs =========== */

    struct ActionInfo {
        IERC20 underlying;              // the underlying token
        address collateralToken;        // the collateral token used to represent ownership of the underlying token
        IERC20 debtToken;               // the debt token being borrowed by the leveraged product
        address entryContract;          // the smart contract used to interact with the lending marker
        bool isCompound;                // whether the collateral is on Compound or Aave
        uint256 collateralAmount;       // amount of collateral tokens per set
        uint256 debtAmount;             // refund amount per set
        IUniswapV2Router debtRouter;
        address[] debtPath;
    }

    /* ======== State Variables ======== */

    IDebtIssuanceModule public immutable debtIssuanceModule;
    ILeverageModule public immutable compLeverageModule;
    ILeverageModule public immutable aaveLeverageModule;
    IAaveLendingPool public immutable aaveLendingPool;
    ICEth public immutable cEth;
    IWETH public immutable weth;

    /* =========== Constructor =========== */

    constructor(
        IDebtIssuanceModule _debtIssuanceModule,
        ILeverageModule _compLeverageModule,
        ILeverageModule _aaveLeverageModule,
        IAaveLendingPool _aaveLendingPool,
        ICEth _cEth,
        IWETH _weth
    )
        public
    {
        debtIssuanceModule = _debtIssuanceModule;
        compLeverageModule = _compLeverageModule;
        aaveLeverageModule = _aaveLeverageModule;
        aaveLendingPool = _aaveLendingPool;
        cEth = _cEth;
        weth = _weth;
    }

    /* ======== External Functions ======== */

    fallback() external payable {}

    function issueExactOutput(
        ISetToken _setToken,
        uint256 _amountOut,
        uint256 _maxIn,
        IERC20 _inputToken,
        IUniswapV2Router _inputRouter,
        address[] memory _inputPath,
        IUniswapV2Router _debtRouter,
        address[] memory _debtPath
    )
        external
        returns (uint256)
    {
        ActionInfo memory actionInfo = _getActionInfo(_setToken, _debtRouter, _debtPath, true);

        uint256 underlyingNeeded = _getUnderlyingNeededForExactOutput(_amountOut, actionInfo);
        
        uint256 flashLoanAmount = _debtRouter.getAmountsOut(_amountOut.preciseMul(actionInfo.debtAmount), _debtPath)[_debtPath.length.sub(1)];
        flashLoanAmount = flashLoanAmount.preciseDivCeil(1.0009 ether);
        
        uint256 preflashNeeded = underlyingNeeded.sub(flashLoanAmount);

        uint256 inputNeeded = preflashNeeded;

        if (_inputToken != actionInfo.underlying) {
            inputNeeded = _inputRouter.getAmountsIn(preflashNeeded, _inputPath)[0];
            _inputToken.safeTransferFrom(msg.sender, address(this), inputNeeded);
            _handleApproval(_inputToken, address(_inputRouter), inputNeeded);
            _inputRouter.swapTokensForExactTokens(preflashNeeded, _maxIn, _inputPath, address(this), PreciseUnitMath.MAX_UINT_256);
        } else {
            require(preflashNeeded <= _maxIn, "EXCESSIVE_INPUT_AMOUNT");
            _inputToken.safeTransferFrom(msg.sender, address(this), preflashNeeded);
        }

        bytes memory flashLoanParams = abi.encode(_setToken, TradeType.EXACT_OUTPUT_ISSUE, actionInfo, _amountOut, msg.sender);
        _flashLoan(actionInfo.underlying, flashLoanAmount, flashLoanParams);

        return inputNeeded;
    }

    function redeemExactInput(
        ISetToken _setToken,
        uint256 _amountIn,
        uint256 _minOut,
        IERC20 _outputToken,
        IUniswapV2Router _outputRouter,
        address[] memory _outputPath,
        IUniswapV2Router _debtRouter,
        address[] memory _debtPath
    )
        external
        returns (uint256)
    {
        _setToken.transferFrom(msg.sender, address(this), _amountIn);

        ActionInfo memory actionInfo = _getActionInfo(_setToken, _debtRouter, _debtPath, false);
        uint256 debtNeeded = actionInfo.debtAmount.preciseMul(_amountIn);

        bytes memory flashLoanParams = abi.encode(_setToken, TradeType.EXACT_INPUT_REDEEM, actionInfo, _amountIn, msg.sender);
        _flashLoan(actionInfo.debtToken, debtNeeded, flashLoanParams);

        uint256 underlyingLeft = IERC20(actionInfo.underlying).balanceOf(address(this));

        if (address(_outputToken) == address(actionInfo.underlying)) {
            require(underlyingLeft >= _minOut, "INSUFFICIENT_OUTPUT_AMOUNT");
            IERC20(actionInfo.underlying).transfer(msg.sender, underlyingLeft);
            return underlyingLeft;
        } else {
            _handleApproval(actionInfo.underlying, address(_outputRouter), underlyingLeft);
            return _outputRouter.swapExactTokensForTokens(
                underlyingLeft,
                _minOut,
                _outputPath,
                msg.sender,
                PreciseUnitMath.MAX_UINT_256
            )[_outputPath.length.sub(1)];
        }
    }

    function executeOperation(
        address[] calldata /* _assets */,
        uint256[] calldata /* _amounts */,
        uint256[] calldata /* _premiums */,
        address /* _initiator */,
        bytes calldata _params
    )
        external
        override
        returns (bool)
    {
        (ISetToken setToken, TradeType tradeType, ActionInfo memory actionInfo, uint256 amount, address recipient) = 
            abi.decode(_params, (ISetToken, TradeType, ActionInfo, uint256, address));

        if (tradeType == TradeType.EXACT_OUTPUT_ISSUE) {
            _completeIssueExactOutput(setToken, actionInfo, amount, recipient);
        } else if (tradeType == TradeType.EXACT_INPUT_REDEEM) {
            _completeRedeemExactInput(setToken, actionInfo, amount);
        }
    }

    /* ========= Internal Functions ========= */

    function _flashLoan(IERC20 _asset, uint256 _amount, bytes memory _params) internal {

        address[] memory underlyings = new address[](1);
        underlyings[0] = address(_asset);
        
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = _amount;

        uint256[] memory modes = new uint256[](1);
        modes[0] = 0;

        aaveLendingPool.flashLoan(address(this), underlyings, amounts, modes, address(this), _params, 0);
    }

    function _completeIssueExactOutput(ISetToken _setToken, ActionInfo memory _actionInfo, uint256 _amount, address _recipient) internal {

        uint256 wrappedCollateralAmount = _wrapCollateral(_actionInfo);

        _handleApproval(IERC20(_actionInfo.collateralToken), address(debtIssuanceModule), wrappedCollateralAmount);
        debtIssuanceModule.issue(_setToken, _amount, _recipient);

        uint256 totalDebt = _actionInfo.debtAmount.preciseMul(_amount);

        _handleApproval(IERC20(_actionInfo.debtPath[0]), address(_actionInfo.debtRouter), totalDebt);
        uint256 output = _actionInfo.debtRouter.swapExactTokensForTokens(
            totalDebt,
            0,
            _actionInfo.debtPath,
            address(this),
            PreciseUnitMath.MAX_UINT_256
        )[_actionInfo.debtPath.length.sub(1)];

        _handleApproval(_actionInfo.underlying, address(aaveLendingPool), output);
    }

    function _completeRedeemExactInput(ISetToken _setToken, ActionInfo memory _actionInfo, uint256 _amount) internal {
        
        uint256 debtNeeded = _actionInfo.debtAmount.preciseMul(_amount);
        
        _handleApproval(_actionInfo.debtToken, address(debtIssuanceModule), debtNeeded);
        _handleApproval(_setToken, address(debtIssuanceModule), _amount);

        debtIssuanceModule.redeem(_setToken, _amount, address(this));

        _unrwapCollateral(_actionInfo);

        uint256 debtOwed = debtNeeded.preciseMul(1.0009 ether);
        uint256 collateralRepaymentAmount = _actionInfo.debtRouter.getAmountsIn(debtOwed, _actionInfo.debtPath)[0];
        _handleApproval(_actionInfo.underlying, address(_actionInfo.debtRouter), collateralRepaymentAmount);

        _actionInfo.debtRouter.swapTokensForExactTokens(
            debtOwed,
            PreciseUnitMath.MAX_UINT_256,
            _actionInfo.debtPath,
            address(this),
            PreciseUnitMath.MAX_UINT_256
        );

        _handleApproval(_actionInfo.debtToken, address(aaveLendingPool), debtOwed);
    }

    function _wrapCollateral(ActionInfo memory _actionInfo) internal returns (uint256) {
        if (_actionInfo.isCompound) {
            return _wrapCompound(_actionInfo);
        } else {
            // TODO: implement Aave wrapping
            revert("not implemented");
        }
    }

    function _unrwapCollateral(ActionInfo memory _actionInfo) internal returns (uint256) {
        if (_actionInfo.isCompound) {
            return _unwrapCompound(_actionInfo);
        } else {
            // TODO: implement Aave unwrapping
            revert("not implemented");
        }
    }

    function _wrapCompound(ActionInfo memory _actionInfo) internal returns (uint256) {
        if (address(_actionInfo.collateralToken) == address(cEth)) {
            uint256 wethBalance = weth.balanceOf(address(this));
            weth.withdraw(wethBalance);
            cEth.mint{ value: wethBalance }();
            return cEth.balanceOf(address(this));
        } else {
            uint256 underlyingBalance = _actionInfo.underlying.balanceOf(address(this));
            _handleApproval(_actionInfo.underlying, _actionInfo.collateralToken, underlyingBalance);
            ICErc20(_actionInfo.collateralToken).mint(underlyingBalance);
            return IERC20(_actionInfo.collateralToken).balanceOf(address(this));
        }
    }

    function _unwrapCompound(ActionInfo memory _actionInfo) internal returns (uint256) {

        uint256 collateralBalance = IERC20(_actionInfo.collateralToken).balanceOf(address(this));
        ICErc20(_actionInfo.collateralToken).redeem(collateralBalance);

        if (address(_actionInfo.underlying) == address(weth)) {
            weth.deposit{value: address(this).balance}();
        }

        return _actionInfo.underlying.balanceOf(address(this));
    }

    function _handleApproval(IERC20 _token, address _spender, uint256 _amount) internal {
        if (_token.allowance(address(this), _spender) < _amount) {
            _token.safeApprove(_spender, PreciseUnitMath.MAX_UINT_256);
        }
    }

    /* ========= Internal Getters ========= */

    function _getLeverageModule(ISetToken _setToken) internal view returns (ILeverageModule) {
        return compLeverageModule;
    }

    function _getActionInfo(
        ISetToken _setToken,
        IUniswapV2Router _debtRouter,
        address[] memory _debtPath,
        bool _isIssue
    )
        internal
        returns (ActionInfo memory actionInfo)
    {

        // TODO: fix this
        actionInfo.isCompound = true;

        actionInfo.debtRouter = _debtRouter;
        actionInfo.debtPath = _debtPath;

        if (actionInfo.isCompound) {
            compLeverageModule.sync(_setToken, true);
        } else {
            aaveLeverageModule.sync(_setToken, true);
        }

        (address[] memory tokens ,uint256[] memory collateralAmounts, uint256[] memory debtAmounts) = _isIssue ? 
            debtIssuanceModule.getRequiredComponentIssuanceUnits(_setToken, 1 ether) :
            debtIssuanceModule.getRequiredComponentRedemptionUnits(_setToken, 1 ether);

        if (collateralAmounts[0] == 0) {
            actionInfo.collateralToken = tokens[1];
            actionInfo.collateralAmount = collateralAmounts[1];
            actionInfo.debtToken = IERC20(tokens[0]);
            actionInfo.debtAmount = debtAmounts[0];
        } else {
            actionInfo.collateralToken = tokens[0];
            actionInfo.collateralAmount = collateralAmounts[0];
            actionInfo.debtToken = IERC20(tokens[1]);
            actionInfo.debtAmount = debtAmounts[1];
        }

        if (actionInfo.collateralToken == address(cEth)) {
            actionInfo.underlying = weth;
        } else {
            actionInfo.underlying = IERC20(ICErc20(actionInfo.collateralToken).underlying());
        }
    }

    function _getUnderlyingNeededForExactOutput(
        uint256 _quantity,
        ActionInfo memory _actionInfo
    )
        internal
        returns (uint256)
    {
        return _getUnderlyingAmount(_quantity, _actionInfo);
    }

    function _getUnderlyingAmount(uint256 _setQuantity, ActionInfo memory _actionInfo) internal returns (uint256) {

        uint256 collateralAmount = _actionInfo.collateralAmount.preciseMul(_setQuantity);

        if (_actionInfo.isCompound) {
            uint256 exchangeRate = ICErc20(_actionInfo.collateralToken).exchangeRateCurrent();
            return collateralAmount.preciseMulCeil(exchangeRate);
        } else {
            return collateralAmount;
        }
    }
}