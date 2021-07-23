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

    enum TradeType { EXACT_OUTPUT_ISSUE }

    /* =========== Structs =========== */

    struct IssueInfo {
        IERC20 underlying;              // the underlying token
        address collateralToken;        // the collateral token used to represent ownership of the underlying token
        address entryContract;          // the smart contract used to interact with the lending marker
        bool isCompound;                // whether the collateral is on Compound or Aave
        uint256 collateralAmount;       // amount of collateral tokens per set
        uint256 debtAmount;           // refund side per set
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
        IssueInfo memory issueInfo = _getIssueInfo(_setToken, _debtRouter, _debtPath);

        uint256 underlyingNeeded = _getUnderlyingNeededForExactOutput(_amountOut, issueInfo);
        
        uint256 flashLoanAmount = _debtRouter.getAmountsOut(_amountOut.preciseMul(issueInfo.debtAmount), _debtPath)[_debtPath.length.sub(1)];
        flashLoanAmount = flashLoanAmount.preciseDivCeil(1.0009 ether);
        
        uint256 preflashNeeded = underlyingNeeded.sub(flashLoanAmount);
        
        if (_inputToken != issueInfo.underlying) {
            uint256 inputNeeded = _inputRouter.getAmountsIn(preflashNeeded, _inputPath)[0];
            _inputToken.safeTransferFrom(msg.sender, address(this), inputNeeded);
            _handleApproval(_inputToken, address(_inputRouter), inputNeeded);
            _inputRouter.swapTokensForExactTokens(preflashNeeded, _maxIn, _inputPath, address(this), PreciseUnitMath.MAX_UINT_256);
        } else {
            _inputToken.safeTransferFrom(msg.sender, address(this), preflashNeeded);
        }

        bytes memory flashLoanParams = abi.encode(_setToken, TradeType.EXACT_OUTPUT_ISSUE, issueInfo, _amountOut, msg.sender);
        _flashLoan(issueInfo.underlying, flashLoanAmount, flashLoanParams);
    }

    function executeOperation(
        address[] calldata _assets,
        uint256[] calldata _amounts,
        uint256[] calldata _premiums,
        address _initiator,
        bytes calldata _params
    )
        external
        override
        returns (bool)
    {
        (ISetToken setToken, TradeType tradeType, IssueInfo memory issueInfo, uint256 amount, address recipient) = 
            abi.decode(_params, (ISetToken, TradeType, IssueInfo, uint256, address));

        if (tradeType == TradeType.EXACT_OUTPUT_ISSUE) {
            _completeIssueExactOutput(setToken, issueInfo, amount, recipient);
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

    function _completeIssueExactOutput(ISetToken _setToken, IssueInfo memory _issueInfo, uint256 _amount, address _recipient) internal {

        uint256 wrappedCollateralAmount = _wrapCollateral(_issueInfo);

        _handleApproval(IERC20(_issueInfo.collateralToken), address(debtIssuanceModule), wrappedCollateralAmount);
        debtIssuanceModule.issue(_setToken, _amount, _recipient);

        uint256 totalDebt = _issueInfo.debtAmount.preciseMul(_amount);

        _handleApproval(IERC20(_issueInfo.debtPath[0]), address(_issueInfo.debtRouter), totalDebt);
        uint256 output = _issueInfo.debtRouter.swapExactTokensForTokens(
            totalDebt,
            0,
            _issueInfo.debtPath,
            address(this),
            PreciseUnitMath.MAX_UINT_256
        )[_issueInfo.debtPath.length.sub(1)];

        _handleApproval(_issueInfo.underlying, address(aaveLendingPool), output);
    }

    function _wrapCollateral(IssueInfo memory _issueInfo) internal returns (uint256) {
        if (_issueInfo.isCompound) {
            return _wrapCompound(_issueInfo);
        } else {
            // TODO: implement Aave wrapping
            revert("not implemented");
        }
    }

    function _wrapCompound(IssueInfo memory _issueInfo) internal returns (uint256) {
        if (address(_issueInfo.collateralToken) == address(cEth)) {
            uint256 wethBalance = weth.balanceOf(address(this));
            weth.withdraw(wethBalance);
            cEth.mint{ value: wethBalance }();
            return cEth.balanceOf(address(this));
        } else {
            uint256 underlyingBalance = _issueInfo.underlying.balanceOf(address(this));
            _handleApproval(_issueInfo.underlying, _issueInfo.collateralToken, underlyingBalance);
            ICErc20(_issueInfo.collateralToken).mint(underlyingBalance);
            return IERC20(_issueInfo.collateralToken).balanceOf(address(this));
        }
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

    function _getIssueInfo(
        ISetToken _setToken,
        IUniswapV2Router _debtRouter,
        address[] memory _debtPath
    )
        internal
        returns (IssueInfo memory issueInfo)
    {

        // TODO: fix this
        issueInfo.isCompound = true;

        issueInfo.debtRouter = _debtRouter;
        issueInfo.debtPath = _debtPath;

        if (issueInfo.isCompound) {
            compLeverageModule.sync(_setToken, true);
        } else {
            aaveLeverageModule.sync(_setToken, true);
        }

        (address[] memory tokens ,uint256[] memory collateralAmounts, uint256[] memory debtAmounts) = 
            debtIssuanceModule.getRequiredComponentIssuanceUnits(_setToken, 1 ether);

        if (collateralAmounts[0] == 0) {
            issueInfo.collateralToken = tokens[1];
            issueInfo.collateralAmount = collateralAmounts[1];
            issueInfo.debtAmount = debtAmounts[0];
        } else {
            issueInfo.collateralToken = tokens[0];
            issueInfo.collateralAmount = collateralAmounts[0];
            issueInfo.debtAmount = debtAmounts[1];
        }

        if (issueInfo.collateralToken == address(cEth)) {
            issueInfo.underlying = weth;
        } else {
            issueInfo.underlying = IERC20(ICErc20(issueInfo.collateralToken).underlying());
        }
    }

    function _getUnderlyingNeededForExactOutput(
        uint256 _quantity,
        IssueInfo memory _issueInfo
    )
        internal
        returns (uint256)
    {
        return _getUnderlyingAmount(_quantity, _issueInfo);
    }

    function _getUnderlyingAmount(uint256 _setQuantity, IssueInfo memory _issueInfo) internal returns (uint256) {

        uint256 collateralAmount = _issueInfo.collateralAmount.preciseMul(_setQuantity);

        if (_issueInfo.isCompound) {
            uint256 exchangeRate = ICErc20(_issueInfo.collateralToken).exchangeRateCurrent();
            return collateralAmount.preciseMulCeil(exchangeRate);
        } else {
            return collateralAmount;
        }
    }
}