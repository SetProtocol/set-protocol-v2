/*
    Copyright 2020 Set Labs Inc.

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

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/math/Math.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";

import { IController } from "../../interfaces/IController.sol";
import { Invoke } from "../lib/Invoke.sol";
import { ISetToken } from "../../interfaces/ISetToken.sol";
import { IStakingRewards } from "../../interfaces/external/IStakingRewards.sol";
import { IUniswapV2Pair } from "../../interfaces/external/IUniswapV2Pair.sol";
import { IUniswapV2Router } from "../../interfaces/external/IUniswapV2Router.sol";
import { ModuleBase } from "../lib/ModuleBase.sol";
import { Position } from "../lib/Position.sol";
import { PreciseUnitMath } from "../../lib/PreciseUnitMath.sol";


contract UniswapYieldStrategy is ModuleBase, ReentrancyGuard {
    using Position for ISetToken;
    using Invoke for ISetToken;
    using SafeMath for uint256;
    using SafeCast for uint256;
    using SafeCast for int256;

    /* ============ State Variables ============ */

    IUniswapV2Router public uniswapRouter;
    IUniswapV2Pair public lpToken;
    IERC20 public assetOne;
    IERC20 public assetTwo;
    IERC20 public uni;
    address public feeRecipient;
    IStakingRewards public rewarder;
    ISetToken public setToken;
    uint256 public reservePercentage;        // Precise percentage (e.g. 10^16 = 1%)
    uint256 public slippageTolerance;        // Precise percentage
    uint256 public rewardFee;                // Precise percentage
    uint256 public withdrawalFee;            // Precise percentage
    uint256 public assetOneBaseUnit;
    uint256 public assetTwoBaseUnit;
    uint256 public lpTokenBaseUnit;

    /* ============ Constructor ============ */

    constructor(
        IController _controller,
        IUniswapV2Router _uniswapRouter,
        IUniswapV2Pair _lpToken,
        IERC20 _assetOne,
        IERC20 _assetTwo,
        IERC20 _uni,
        IStakingRewards _rewarder,
        address _feeRecipient
    )
        public
        ModuleBase(_controller)
    {
        controller = _controller;
        uniswapRouter = _uniswapRouter;
        lpToken = _lpToken;
        assetOne = _assetOne;
        assetTwo = _assetTwo;
        uni = _uni;
        rewarder = _rewarder;
        feeRecipient = _feeRecipient;

        uint256 tokenOneDecimals = ERC20(address(_assetOne)).decimals();
        assetOneBaseUnit = 10 ** tokenOneDecimals;
        uint256 tokenTwoDecimals = ERC20(address(_assetTwo)).decimals();
        assetTwoBaseUnit = 10 ** tokenTwoDecimals;
        uint256 lpTokenDecimals = ERC20(address(_lpToken)).decimals();
        lpTokenBaseUnit = 10 ** lpTokenDecimals;
    }

    /* ============ External Functions ============ */

    function engage() external nonReentrant {
        _engage();
    }

    function disengage() external nonReentrant {
        _rebalance(0);

        uint256 lpTokenQuantity = _calculateDisengageLPQuantity();

        _unstake(lpTokenQuantity);

        _approveAndRemoveLiquidity(lpTokenQuantity);

        _updatePositions();
    }

    function reap() external nonReentrant {
        _handleReward();

        _engage();
    }

    function rebalance() external nonReentrant {
        _rebalance(0);

        _updatePositions();
    }

    function rebalanceSome(uint256 _sellTokenQuantity) external nonReentrant {
        _rebalance(_sellTokenQuantity);

        _updatePositions();        
    }

    function unstakeAndRedeem(uint256 _setTokenQuantity) external nonReentrant {
        require(setToken.balanceOf(msg.sender) >= _setTokenQuantity, "User must have sufficient SetToken");

        setToken.burn(msg.sender, _setTokenQuantity);

        uint256 lpTokenUnit = setToken.getExternalPositionRealUnit(address(lpToken), address(this)).toUint256();

        uint256 userLPBalance = lpTokenUnit.preciseMul(_setTokenQuantity);

        _unstake(userLPBalance);

        uint256 lpFees = userLPBalance.preciseMul(withdrawalFee);
        setToken.invokeTransfer(address(lpToken), msg.sender, userLPBalance.sub(lpFees));
        setToken.invokeTransfer(address(lpToken), feeRecipient, lpFees);

        uint256 assetOneUnit = setToken.getDefaultPositionRealUnit(address(assetOne)).toUint256();
        uint256 assetOneNotional = assetOneUnit.preciseMul(_setTokenQuantity);
        uint256 assetOneFee = assetOneNotional.preciseMul(withdrawalFee);
        setToken.invokeTransfer(address(assetOne), msg.sender, assetOneNotional.sub(assetOneFee));
        setToken.invokeTransfer(address(assetOne), feeRecipient, assetOneFee);

        uint256 assetTwoUnit = setToken.getDefaultPositionRealUnit(address(assetTwo)).toUint256();
        uint256 assetTwoNotional = assetTwoUnit.preciseMul(_setTokenQuantity);
        uint256 assetTwoFee = assetTwoNotional.preciseMul(withdrawalFee);
        setToken.invokeTransfer(address(assetTwo), msg.sender, assetTwoNotional.sub(assetTwoFee));
        setToken.invokeTransfer(address(assetTwo), feeRecipient, assetTwoFee);
    }

    function initialize(
        ISetToken _setToken,
        uint256 _reservePercentage,
        uint256 _slippageTolerance,
        uint256 _rewardFee,
        uint256 _withdrawalFee
    )
        external
        onlySetManager(_setToken, msg.sender)
    {
        require(address(setToken) == address(0), "May only be called once");

        setToken = _setToken;
        reservePercentage = _reservePercentage;
        slippageTolerance = _slippageTolerance;
        rewardFee = _rewardFee;
        withdrawalFee = _withdrawalFee;

        _setToken.initializeModule();
    }

    function removeModule() external override {
        require(msg.sender == address(setToken), "Caller must be SetToken");

        uint256 lpBalance = rewarder.balanceOf(address(setToken));

        _unstake(lpBalance);

        _approveAndRemoveLiquidity(lpBalance);

        _updatePositions();
    }

    /* ============ Internal Functions ============ */

    function _engage() internal {
        _rebalance(0);

        (uint256 assetOneQuantity, uint256 assetTwoQuantity) = _calculateEngageQuantities();

        uint256 lpBalance = _approveAndAddLiquidity(assetOneQuantity, assetTwoQuantity);

        _approveAndStake(lpBalance);

        _updatePositions();
    }  

    // Rebalances reserve assets to achieve a 50/50 value split
    // If a sellTokenQuantity is provided, then use this value
    function _rebalance(uint256 _sellTokenQuantity) internal {
        address assetToSell;
        address assetToBuy;
        uint256 quantityToSell;
        uint256 minimumBuyToken;

        uint256 assetOneToTwoPrice = controller.getPriceOracle().getPrice(address(assetOne), address(assetTwo));

        uint256 balanceAssetOne = assetOne.balanceOf(address(setToken));
        uint256 balanceAssetTwo = assetTwo.balanceOf(address(setToken));

        // Convert Asset Two to One adjust for decimal differences
        uint256 valueAssetTwoDenomOne = balanceAssetTwo.preciseDiv(assetOneToTwoPrice).mul(assetOneBaseUnit).div(assetTwoBaseUnit);

        if (balanceAssetOne > valueAssetTwoDenomOne) {
            assetToSell = address(assetOne);
            assetToBuy = address(assetTwo);
            quantityToSell = balanceAssetOne.sub(valueAssetTwoDenomOne).div(2);

            // Base unit calculations are to normalize the values for different decimals
            minimumBuyToken = quantityToSell.preciseMul(assetOneToTwoPrice).mul(assetTwoBaseUnit).div(assetOneBaseUnit);
        } else {
            assetToSell = address(assetTwo);
            assetToBuy = address(assetOne);
            quantityToSell = valueAssetTwoDenomOne
                                .sub(balanceAssetOne).div(2).preciseMul(assetOneToTwoPrice)
                                .mul(assetTwoBaseUnit).div(assetOneBaseUnit);
            minimumBuyToken = quantityToSell.preciseDiv(assetOneToTwoPrice).mul(assetOneBaseUnit).div(assetTwoBaseUnit);
        }

        if (_sellTokenQuantity > 0) {
            require(_sellTokenQuantity <= quantityToSell, "Delta must be less than max");
            minimumBuyToken = minimumBuyToken.preciseMul(_sellTokenQuantity).preciseDiv(quantityToSell);
            quantityToSell = _sellTokenQuantity;
        }

        // Reduce the expected receive quantity 
        minimumBuyToken = minimumBuyToken
            .preciseMul(PreciseUnitMath.preciseUnit().sub(slippageTolerance));

        setToken.invokeApprove(assetToSell, address(uniswapRouter), quantityToSell);
        if (quantityToSell > 0) {
            _invokeUniswapTrade(assetToSell, assetToBuy, quantityToSell, minimumBuyToken);
        }
    }

    function _approveAndAddLiquidity(uint256 _assetOneQuantity, uint256 _assetTwoQuantity) internal returns (uint256) {
        setToken.invokeApprove(address(assetOne), address(uniswapRouter), _assetOneQuantity);
        setToken.invokeApprove(address(assetTwo), address(uniswapRouter), _assetTwoQuantity);

        bytes memory addLiquidityBytes = abi.encodeWithSignature(
            "addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)",
            assetOne,
            assetTwo,
            _assetOneQuantity,
            _assetTwoQuantity,
            1,
            1,
            address(setToken),
            now.add(60) // Valid for one minute
        );

        setToken.invoke(address(uniswapRouter), 0, addLiquidityBytes);

        return lpToken.balanceOf(address(setToken));
    }

    function _approveAndRemoveLiquidity(uint256 _liquidityQuantity) internal {
        setToken.invokeApprove(address(lpToken), address(uniswapRouter), _liquidityQuantity);

        bytes memory removeLiquidityBytes = abi.encodeWithSignature(
            "removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)",
            assetOne,
            assetTwo,
            _liquidityQuantity,
            1,
            1,
            address(setToken),
            now.add(60) // Valid for one minute
        );

        setToken.invoke(address(uniswapRouter), 0, removeLiquidityBytes);
    }

    function _approveAndStake(uint256 _lpTokenQuantity) internal {
        setToken.invokeApprove(address(lpToken), address(rewarder), _lpTokenQuantity);
        bytes memory stakeBytes = abi.encodeWithSignature("stake(uint256)", _lpTokenQuantity);

        setToken.invoke(address(rewarder), 0, stakeBytes);
    }

    function _unstake(uint256 _lpTokenQuantity) internal {
        bytes memory unstakeBytes = abi.encodeWithSignature("withdraw(uint256)", _lpTokenQuantity);

        setToken.invoke(address(rewarder), 0, unstakeBytes);
    }

    function _handleReward() internal {
        setToken.invoke(address(rewarder), 0, abi.encodeWithSignature("getReward()"));

        uint256 uniBalance = uni.balanceOf(address(setToken));
        uint256 assetOneBalance = assetOne.balanceOf(address(setToken));

        setToken.invokeApprove(address(uni), address(uniswapRouter), uniBalance);
        _invokeUniswapTrade(address(uni), address(assetOne), uniBalance, 1);

        uint256 postTradeAssetOneBalance = assetOne.balanceOf(address(setToken));
        uint256 fee = postTradeAssetOneBalance.sub(assetOneBalance).preciseMul(rewardFee);

        setToken.strictInvokeTransfer(address(assetOne), feeRecipient, fee);
    }

    function _invokeUniswapTrade(
        address _sellToken,
        address _buyToken,
        uint256 _amountIn,
        uint256 _amountOutMin
    )
        internal
    {
        address[] memory path = new address[](2);
        path[0] = _sellToken;
        path[1] = _buyToken;

        bytes memory tradeBytes = abi.encodeWithSignature(
            "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
            _amountIn,
            _amountOutMin,
            path,
            address(setToken),
            now.add(180)
        );

        setToken.invoke(address(uniswapRouter), 0, tradeBytes);
    }

    function _calculateEngageQuantities() internal view returns(uint256 tokenAQuantity, uint256 tokenBQuantity) {
        (
            uint256 desiredAssetOne,
            uint256 desiredAssetTwo,
            uint256 assetOneOnSetToken,
            uint256 assetTwoOnSetToken
        ) = _getDesiredSingleAssetReserve();

        require(assetOneOnSetToken > desiredAssetOne && assetTwoOnSetToken > desiredAssetTwo, "SetToken assets must be > desired");

        return (
            assetOneOnSetToken.sub(desiredAssetOne),
            assetTwoOnSetToken.sub(desiredAssetTwo)
        );
    }

    function _calculateDisengageLPQuantity() internal view returns(uint256 _lpTokenQuantity) {
        (uint256 assetOneToLPRate, uint256 assetTwoToLPRate) = _getLPReserveExchangeRate();

        (
            uint256 desiredOne,
            uint256 desiredTwo,
            uint256 assetOneOnSetToken,
            uint256 assetTwoOnSetToken
        ) = _getDesiredSingleAssetReserve();    

        require(assetOneOnSetToken < desiredOne && assetTwoOnSetToken < desiredTwo, "SetToken assets must be < desired");

        // LP Rates already account for decimals
        uint256 minLPForOneToRedeem = desiredOne.sub(assetOneOnSetToken).preciseDiv(assetOneToLPRate);
        uint256 minLPForTwoToRedeem = desiredTwo.sub(assetTwoOnSetToken).preciseDiv(assetTwoToLPRate);

        return Math.max(minLPForOneToRedeem, minLPForTwoToRedeem);
    }

    // Returns desiredOneReserve, desiredTwoReserve, tokenOne and tokenTwo balances
    function _getDesiredSingleAssetReserve()
        internal
        view
        returns(uint256, uint256, uint256, uint256)
    {
        (uint256 assetOneReserve, uint256 assetTwoReserve) = _getTotalLPReserves();
        uint256 balanceAssetOne = assetOne.balanceOf(address(setToken));
        uint256 balanceAssetTwo = assetTwo.balanceOf(address(setToken));

        uint256 desiredOneReserve = assetOneReserve.add(balanceAssetOne).preciseMul(reservePercentage);
        uint256 desiredTwoReserve = assetTwoReserve.add(balanceAssetTwo).preciseMul(reservePercentage);

        return(desiredOneReserve, desiredTwoReserve, balanceAssetOne, balanceAssetTwo);
    }

    // Returns assetAToLPRate and assetBToLPRate
    function _getLPReserveExchangeRate() internal view returns (uint256, uint256) {
        (uint reserve0, uint reserve1) = _getReservesSafe();
        uint256 totalSupply = lpToken.totalSupply();
        return(
            reserve0.preciseDiv(totalSupply),
            reserve1.preciseDiv(totalSupply)
        );
    }

    // Returns assetOneReserve and assetTwoReserve
    function _getTotalLPReserves() internal view returns (uint256, uint256) {
        (uint reserve0, uint reserve1) = _getReservesSafe();
        uint256 totalSupply = lpToken.totalSupply();
        uint256 lpTokenBalance = rewarder.balanceOf(address(setToken));
        return(
            reserve0.mul(lpTokenBalance).div(totalSupply),
            reserve1.mul(lpTokenBalance).div(totalSupply)
        );
    }

    function _updatePositions() internal {
        uint256 totalSupply = setToken.totalSupply();
        uint256 assetOneBalance = assetOne.balanceOf(address(setToken));
        uint256 assetTwoBalance = assetTwo.balanceOf(address(setToken));
        uint256 lpBalance = rewarder.balanceOf(address(setToken));

        // Doesn't check to make sure unit is different, and no check for any LP token on Set
        setToken.editDefaultPosition(address(assetOne), Position.getDefaultPositionUnit(totalSupply, assetOneBalance));
        setToken.editDefaultPosition(address(assetTwo), Position.getDefaultPositionUnit(totalSupply, assetTwoBalance));
        setToken.editExternalPosition(
            address(lpToken),
            address(this),
            Position.getDefaultPositionUnit(totalSupply, lpBalance).toInt256(),
            ""
        );
    }

    // Code pulled to sort from UniswapV2Library
    // https://github.com/Uniswap/uniswap-v2-periphery/blob/master/contracts/libraries/UniswapV2Library.sol
    function _getReservesSafe() internal view returns(uint256, uint256) {
        address firstAsset = address(assetOne) < address(assetTwo) ? address(assetOne) : address(assetTwo);
        (uint reserve0, uint reserve1,) = lpToken.getReserves();
        return address(assetOne) == firstAsset ? (reserve0, reserve1) : (reserve1, reserve0);
    }
}