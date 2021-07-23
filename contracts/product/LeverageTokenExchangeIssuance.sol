pragma solidity 0.6.10;
pragma experimental "ABIEncoderV2";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { ICErc20 } from "../interfaces/external/ICErc20.sol";
import { ICEth } from "../interfaces/external/ICEth.sol";
import { ILeverageModule } from "../interfaces/ILeverageModule.sol";
import { IDebtIssuanceModule } from "../interfaces/IDebtIssuanceModule.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { IUniswapV2Router } from "../interfaces/external/IUniswapV2Router.sol";
import { IWETH } from "../interfaces/external/IWETH.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";

import { console } from "hardhat/console.sol";

contract LeverageTokenExchangeIssuance {
    using SafeERC20 for IERC20;
    using SafeMath for uint256;
    using PreciseUnitMath for uint256;

    /* =========== Structs =========== */

    struct IssueInfo {
        IERC20 underlying;              // the underlying token
        address collateralToken;        // the collateral token used to represent ownership of the underlying token
        address entryContract;          // the smart contract used to interact with the lending marker
        bool isCompound;                // whether the collateral is on Compound or Aave
        uint256 collateralAmount;       // amount of collateral tokens per set
        uint256 refundAmount;           // refund side per set
    }

    /* ======== State Variables ======== */

    IDebtIssuanceModule public immutable debtIssuanceModule;
    ILeverageModule public immutable compLeverageModule;
    ILeverageModule public immutable aaveLeverageModule;
    ICEth public immutable cEth;
    IWETH public immutable weth;

    /* =========== Constructor =========== */

    constructor(
        IDebtIssuanceModule _debtIssuanceModule,
        ILeverageModule _compLeverageModule,
        ILeverageModule _aaveLeverageModule,
        ICEth _cEth,
        IWETH _weth
    )
        public
    {
        debtIssuanceModule = _debtIssuanceModule;
        compLeverageModule = _compLeverageModule;
        aaveLeverageModule = _aaveLeverageModule;
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
        IssueInfo memory issueInfo = _getIssueInfo(_setToken);

        uint256 underlyingNeeded = _getUnderlyingNeededForExactOutput(_amountOut, issueInfo);
        
        if (_inputToken != issueInfo.underlying) {
            uint256 inputNeeded = _inputRouter.getAmountsIn(underlyingNeeded, _inputPath)[0];
            _inputToken.safeTransferFrom(msg.sender, address(this), inputNeeded);
            _inputRouter.swapTokensForExactTokens(underlyingNeeded, _maxIn, _inputPath, address(this), PreciseUnitMath.MAX_UINT_256);
        } else {
            _inputToken.safeTransferFrom(msg.sender, address(this), underlyingNeeded);
        }

        uint256 wrappedCollateralAmount = _wrapCollateral(issueInfo);
        _handleApproval(IERC20(issueInfo.collateralToken), address(debtIssuanceModule), wrappedCollateralAmount);
        
        debtIssuanceModule.issue(_setToken, _amountOut, msg.sender);
    }

    /* ========= Internal Functions ========= */

    function _swapRemaining(
        IERC20 _inputToken,
        IERC20 _outputToken,
        IUniswapV2Router _router,
        address[] memory _path
    )
        internal
        returns (uint256)
    {
        uint256 inputAmount = _inputToken.balanceOf(address(this));
        return _router.swapExactTokensForTokens(inputAmount, 0, _path, address(this), PreciseUnitMath.MAX_UINT_256)[_path.length.sub(1)];
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
            // TODO: implement CErc20 deposits
            revert("not implemented");
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

    function _getIssueInfo(ISetToken _setToken) internal returns (IssueInfo memory issueInfo) {

        // TODO: fix this
        issueInfo.isCompound = true;

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
            issueInfo.refundAmount = debtAmounts[0];
        } else {
            issueInfo.collateralToken = tokens[0];
            issueInfo.collateralAmount = collateralAmounts[0];
            issueInfo.refundAmount = debtAmounts[1];
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
            // TODO: fix for different decimal amounts
            uint256 exchangeRate = ICErc20(_issueInfo.collateralToken).exchangeRateCurrent();
            return collateralAmount.preciseMulCeil(exchangeRate);
        } else {
            return collateralAmount;
        }
    }
}