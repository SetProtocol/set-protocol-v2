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

import "../../../interfaces/external/IUniswapV2Router.sol";
import "../../../interfaces/external/IUniswapV2Pair.sol";
import "../../../interfaces/external/IUniswapV2Factory.sol";
import "../../../interfaces/IAmmAdapter.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@uniswap/lib/contracts/libraries/Babylonian.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

struct Position {
  IERC20 tokenA;
  uint256 amountA;
  IERC20 tokenB;
  uint256 amountB;
}

/**
 * @title UniswapV2AmmAdapter
 * @author Stephen Hankinson
 *
 * Adapter for Uniswap V2 Router that encodes adding and removing liquidty
 */
contract UniswapV2AmmAdapter is IAmmAdapter {
    using SafeMath for uint256;

    /* ============ State Variables ============ */

    // Address of Uniswap V2 Router contract
    IUniswapV2Router public immutable router;
    IUniswapV2Factory public immutable factory;

    // Fee settings for the AMM
    uint256 internal immutable feeNumerator;
    uint256 internal immutable feeDenominator;

    // Internal function string for adding liquidity
    string internal constant ADD_LIQUIDITY =
        "addLiquidity(address,address[],uint256[],uint256,bool)";
    // Internal function string for adding liquidity with a single asset
    string internal constant ADD_LIQUIDITY_SINGLE_ASSET =
        "addLiquiditySingleAsset(address,address,uint256,uint256)";
    // Internal function string for removing liquidity
    string internal constant REMOVE_LIQUIDITY =
        "removeLiquidity(address,address[],uint256[],uint256,bool)";
    // Internal function string for removing liquidity to a single asset
    string internal constant REMOVE_LIQUIDITY_SINGLE_ASSET =
        "removeLiquiditySingleAsset(address,address,uint256,uint256)";

    /* ============ Constructor ============ */

    /**
     * Set state variables
     *
     * @param _router          Address of Uniswap V2 Router contract
     * @param _feeNumerator    Numerator of the fee component (usually 997)
     * @param _feeDenominator  Denominator of the fee component (usually 1000)
     */
    constructor(address _router, uint256 _feeNumerator, uint256 _feeDenominator) public {
        router = IUniswapV2Router(_router);
        factory = IUniswapV2Factory(IUniswapV2Router(_router).factory());
        feeNumerator = _feeNumerator;
        feeDenominator = _feeDenominator;
    }

    /* ============ Internal Functions =================== */

    /**
     * Returns the pair reserves in an expected order
     *
     * @param  pair                   The pair to get the reserves from
     * @param  tokenA                 Address of the token to swap
     */
    function getReserves(
        IUniswapV2Pair pair,
        address tokenA
    )
        internal
        view
        returns (
            uint reserveA,
            uint reserveB
        ) 
    {
        address token0 = pair.token0();
        (uint reserve0, uint reserve1,) = pair.getReserves();
        (reserveA, reserveB) = tokenA == token0 ? (reserve0, reserve1) : (reserve1, reserve0);
    }

    /**
     * Performs a swap via the Uniswap V2 Router
     *
     * @param  pair                   The pair to perform the swap on
     * @param  tokenA                 Address of the token to swap
     * @param  tokenB                 Address of pair token0
     * @param  amount                 Amount of the token to swap
     */
    function performSwap(
        IUniswapV2Pair pair,
        address tokenA,
        address tokenB,
        uint256 amount
    )
        internal
        returns (
            uint[] memory amounts
        )
    {

        // Get the reserves of the pair
        (uint256 reserveA, uint256 reserveB) = getReserves(pair, tokenA);

        // Use half of the provided amount in the swap
        uint256 amountToSwap = this.calculateSwapAmount(amount, reserveA);

        // Approve the router to spend the tokens
        IERC20(tokenA).approve(address(router), amountToSwap);

        // Determine how much we should expect of token1
        uint256 amountOut = router.getAmountOut(amountToSwap, reserveA, reserveB);

        // Perform the swap
        address[] memory path = new address[](2);
        path[0] = tokenA;
        path[1] = tokenB;
        amounts = router.swapExactTokensForTokens(
            amountToSwap,
            amountOut,
            path,
            address(this),
            block.timestamp // solhint-disable-line not-rely-on-time
        );

        // How much token do we have left?
        amounts[0] = amount.sub(amountToSwap);

    }

    /* ============ External Getter Functions ============ */

    /**
     * Returns the amount of tokenA to swap
     *
     * @param  amountA                  The amount of tokenA being supplied
     * @param  reserveA                 The reserve of tokenA in the pool
     */
    function calculateSwapAmount(
        uint256 amountA,
        uint256 reserveA
    )
        external
        view
        returns (
            uint256 swapAmount
        )
    {
        // Solves the following system of equations to find the ideal swapAmount
        // eq1: amountA = swapAmount + amountALP
        // eq2: amountBLP = swapAmount * feeNumerator * reserveB / (reserveA * feeDenominator + swapAmount * feeNumerator)
        // eq3: amountALP = amountBLP * (reserveA + swapAmount) / (reserveB - amountBLP)
        // Substitution: swapAmount^2 * feeNumerator + swapAmount * reserveA * (feeNumerator + feeDenominator) - amountA * reserveA * feeDenominator = 0
        // Solution: swapAmount = (-b +/- sqrt(b^2-4ac))/(2a)
        // a = feeNumerator
        // b = reserveA * (feeNumerator + feeDenominator)
        // c = -amountA * reserveA * feeDenominator
        // Note: a is always positive. b is always positive. The solved
        // equation has a negative multiplier on c but that is ignored here because the
        // negative in front of the 4ac in the quadratic solution would cancel it out,
        // making it an addition. Since b is always positive, we never want to take
        // the negative square root solution since that would always cause a negative
        // swapAmount, which doesn't make sense. Therefore, we only use the positive
        // square root value as the solution.
        uint256 b = reserveA.mul(feeNumerator.add(feeDenominator));
        uint256 c = amountA.mul(feeDenominator).mul(reserveA);

        swapAmount = Babylonian.sqrt(b.mul(b).add(feeNumerator.mul(c).mul(4)))
            .sub(b).div(feeNumerator.mul(2));
    }

    /**
     * Return calldata for the add liquidity call
     *
     * @param  _pool                    Address of liquidity token
     * @param  _components              Address array required to add liquidity
     * @param  _maxTokensIn             AmountsIn desired to add liquidity
     * @param  _minLiquidity            Min liquidity amount to add
     */
    function getProvideLiquidityCalldata(
        address _pool,
        address[] calldata _components,
        uint256[] calldata _maxTokensIn,
        uint256 _minLiquidity
    )
        external
        view
        override
        returns (
            address _target,
            uint256 _value,
            bytes memory _calldata
        )
    {
        _target = address(this);
        _value = 0;
        _calldata = abi.encodeWithSignature(
            ADD_LIQUIDITY,
            _pool,
            _components,
            _maxTokensIn,
            _minLiquidity,
            true
        );
    }

    /**
     * Return calldata for the add liquidity call for a single asset
     *
     * @param  _pool                    Address of liquidity token
     * @param  _component               Address of the token used to add liquidity
     * @param  _maxTokenIn              AmountsIn desired to add liquidity
     * @param  _minLiquidity            Min liquidity amount to add
     */
    function getProvideLiquiditySingleAssetCalldata(
        address _pool,
        address _component,
        uint256 _maxTokenIn,
        uint256 _minLiquidity
    )
        external
        view
        override
        returns (
            address _target,
            uint256 _value,
            bytes memory _calldata
        )
    {
        _target = address(this);
        _value = 0;
        _calldata = abi.encodeWithSignature(
            ADD_LIQUIDITY_SINGLE_ASSET,
            _pool,
            _component,
            _maxTokenIn,
            _minLiquidity
        );
    }

    /**
     * Return calldata for the remove liquidity call
     *
     * @param  _pool                    Address of liquidity token
     * @param  _components              Address array required to remove liquidity
     * @param  _minTokensOut            AmountsOut minimum to remove liquidity
     * @param  _liquidity               Liquidity amount to remove
     */
    function getRemoveLiquidityCalldata(
        address _pool,
        address[] calldata _components,
        uint256[] calldata _minTokensOut,
        uint256 _liquidity
    )
        external
        view
        override
        returns (
            address _target,
            uint256 _value,
            bytes memory _calldata
        )
    {
        _target = address(this);
        _value = 0;
        _calldata = abi.encodeWithSignature(
            REMOVE_LIQUIDITY,
            _pool,
            _components,
            _minTokensOut,
            _liquidity,
            true
        );
    }

    /**
     * Return calldata for the remove liquidity single asset call
     *
     * @param  _pool                    Address of liquidity token
     * @param  _component               Address of token required to remove liquidity
     * @param  _minTokenOut             AmountsOut minimum to remove liquidity
     * @param  _liquidity               Liquidity amount to remove
     */
    function getRemoveLiquiditySingleAssetCalldata(
        address _pool,
        address _component,
        uint256 _minTokenOut,
        uint256 _liquidity
    )
        external
        view
        override
        returns (
            address _target,
            uint256 _value,
            bytes memory _calldata
        )
    {
        _target = address(this);
        _value = 0;
        _calldata = abi.encodeWithSignature(
            REMOVE_LIQUIDITY_SINGLE_ASSET,
            _pool,
            _component,
            _minTokenOut,
            _liquidity
        );
    }

    /**
     * Returns the address of the spender
     *
     * @param  _pool       Address of liquidity token
     */
    function getSpenderAddress(address _pool)
        external
        view
        override
        returns (address)
    {
        IUniswapV2Pair pair = IUniswapV2Pair(_pool);
        require(factory == IUniswapV2Factory(pair.factory()), "_pool factory doesn't match the router factory");

        return address(this);
    }

    /**
     * Verifies that this is a valid Uniswap V2 _pool
     *
     * @param  _pool       Address of liquidity token
     */
    function isValidPool(address _pool) external view override returns (bool) {
        address token0;
        address token1;
        bool success = true;
        IUniswapV2Pair pair = IUniswapV2Pair(_pool);

        try pair.token0() returns (address _token0) {
            token0 = _token0;
        } catch {
            success = false;
        }

        try pair.token1() returns (address _token1) {
            token1 = _token1;
        } catch {
            success = false;
        }

        if( success ) {
            return factory.getPair(token0, token1) == _pool;
        }
        else {
            return false;
        }
    }

    /* ============ External Setter Functions ============ */

    /**
     * Adds liquidity via the Uniswap V2 Router
     *
     * @param  _pool                    Address of liquidity token
     * @param  _components              Address array required to add liquidity
     * @param  _maxTokensIn             AmountsIn desired to add liquidity
     * @param  _minLiquidity            Min liquidity amount to add
     * @param  _shouldTransfer          Should the tokens be transferred from the sender
     */
    function addLiquidity(
        address _pool,
        address[] memory _components,
        uint256[] memory _maxTokensIn,
        uint256 _minLiquidity,
        bool _shouldTransfer
    )
        public
        returns (
            uint amountA,
            uint amountB,
            uint liquidity
        )
    {

        IUniswapV2Pair pair = IUniswapV2Pair(_pool);
        require(factory == IUniswapV2Factory(pair.factory()), "_pool factory doesn't match the router factory");
        require(_components.length == 2, "_components length is invalid");
        require(_maxTokensIn.length == 2, "_maxTokensIn length is invalid");
        require(factory.getPair(_components[0], _components[1]) == _pool, 
            "_pool doesn't match the components");
        require(_maxTokensIn[0] > 0, "supplied token0 must be greater than 0");
        require(_maxTokensIn[1] > 0, "supplied token1 must be greater than 0");
        require(_minLiquidity > 0, "_minLiquidity must be greater than 0");

        Position memory position = Position(IERC20(_components[0]), _maxTokensIn[0],
            IERC20(_components[1]), _maxTokensIn[1]);

        uint256 lpTotalSupply = pair.totalSupply();
        require(lpTotalSupply > 0, "_pool totalSupply must be > 0");

        (uint256 reserveA, uint256 reserveB) = getReserves(pair, _components[0]);
        uint256 amountAMin = reserveA.mul(_minLiquidity).div(lpTotalSupply);
        uint256 amountBMin = reserveB.mul(_minLiquidity).div(lpTotalSupply);

        require(amountAMin <= position.amountA && amountBMin <= position.amountB,
            "_minLiquidity is too high for amount maximums");

        // Bring the tokens to this contract, if needed, so we can use the Uniswap Router
        if( _shouldTransfer ) {
            position.tokenA.transferFrom(msg.sender, address(this), position.amountA);
            position.tokenB.transferFrom(msg.sender, address(this), position.amountB);
        }

        // Approve the router to spend the tokens
        position.tokenA.approve(address(router), position.amountA);
        position.tokenB.approve(address(router), position.amountB);

        // Add the liquidity
        (amountA, amountB, liquidity) = router.addLiquidity(
            address(position.tokenA),
            address(position.tokenB),
            position.amountA,
            position.amountB,
            amountAMin,
            amountBMin,
            msg.sender,
            block.timestamp // solhint-disable-line not-rely-on-time
        );

        // If there is token0 left, send it back
        if( amountA < position.amountA ) {
            position.tokenA.transfer(msg.sender, position.amountA.sub(amountA) );
        }

        // If there is token1 left, send it back
        if( amountB < position.amountB ) {
            position.tokenB.transfer(msg.sender, position.amountB.sub(amountB) );
        }

    }

    /**
     * Adds liquidity via the Uniswap V2 Router, swapping first to get both tokens
     *
     * @param  _pool                    Address of liquidity token
     * @param  _component               Address array required to add liquidity
     * @param  _maxTokenIn              AmountsIn desired to add liquidity
     * @param  _minLiquidity            Min liquidity amount to add
     */
    function addLiquiditySingleAsset(
        address _pool,
        address _component,
        uint256 _maxTokenIn,
        uint256 _minLiquidity
    )
        external
        returns (
            uint amountA,
            uint amountB,
            uint liquidity
        )
    {

        IUniswapV2Pair pair = IUniswapV2Pair(_pool);
        require(factory == IUniswapV2Factory(pair.factory()), "_pool factory doesn't match the router factory");

        address tokenA = pair.token0();
        address tokenB = pair.token1();
        require(tokenA == _component || tokenB == _component, "_pool doesn't contain the _component");
        require(_maxTokenIn > 0, "supplied _maxTokenIn must be greater than 0");
        require(_minLiquidity > 0, "supplied _minLiquidity must be greater than 0");

        // Swap them if needed
        if( tokenB == _component ) {
            tokenB = tokenA;
            tokenA = _component;
        }

        uint256 lpTotalSupply = pair.totalSupply();
        require(lpTotalSupply > 0, "_pool totalSupply must be > 0");

        // Bring the tokens to this contract so we can use the Uniswap Router
        IERC20(tokenA).transferFrom(msg.sender, address(this), _maxTokenIn);

        // Execute the swap
        uint[] memory amounts = performSwap(pair, tokenA, tokenB, _maxTokenIn);

        address[] memory components = new address[](2);
        components[0] = tokenA;
        components[1] = tokenB;

        // Add the liquidity
        (amountA, amountB, liquidity) = addLiquidity(_pool, components, amounts, _minLiquidity, false);

    }

    /**
     * Remove liquidity via the Uniswap V2 Router
     *
     * @param  _pool                    Address of liquidity token
     * @param  _components              Address array required to remove liquidity
     * @param  _minTokensOut            AmountsOut minimum to remove liquidity
     * @param  _liquidity               Liquidity amount to remove
     * @param  _shouldReturn            Should the tokens be returned to the sender?
     */
    function removeLiquidity(
        address _pool,
        address[] memory _components,
        uint256[] memory _minTokensOut,
        uint256 _liquidity,
        bool _shouldReturn
    )
        public
        returns (
            uint amountA,
            uint amountB
        )
    {
        IUniswapV2Pair pair = IUniswapV2Pair(_pool);
        require(factory == IUniswapV2Factory(pair.factory()), "_pool factory doesn't match the router factory");
        require(_components.length == 2, "_components length is invalid");
        require(_minTokensOut.length == 2, "_minTokensOut length is invalid");
        require(factory.getPair(_components[0], _components[1]) == _pool, 
            "_pool doesn't match the components");
        require(_minTokensOut[0] > 0, "requested token0 must be greater than 0");
        require(_minTokensOut[1] > 0, "requested token1 must be greater than 0");
        require(_liquidity > 0, "_liquidity must be greater than 0");

        Position memory position = Position(IERC20(_components[0]), _minTokensOut[0],
            IERC20(_components[1]), _minTokensOut[1]);

        uint256 balance = pair.balanceOf(msg.sender);
        require(_liquidity <= balance, "_liquidity must be <= to current balance");

        // Calculate how many tokens are owned by the liquidity
        uint[] memory tokenInfo = new uint[](3);
        tokenInfo[2] = pair.totalSupply();
        (tokenInfo[0], tokenInfo[1]) = getReserves(pair, _components[0]);
        tokenInfo[0] = tokenInfo[0].mul(balance).div(tokenInfo[2]);
        tokenInfo[1] = tokenInfo[1].mul(balance).div(tokenInfo[2]);

        require(position.amountA <= tokenInfo[0] && position.amountB <= tokenInfo[1],
            "amounts must be <= ownedTokens");   

        // Bring the lp token to this contract so we can use the Uniswap Router
        pair.transferFrom(msg.sender, address(this), _liquidity);

        // Approve the router to spend the lp tokens
        pair.approve(address(router), _liquidity);

        // Remove the liquidity
        (amountA, amountB) = router.removeLiquidity(
            address(position.tokenA),
            address(position.tokenB),
            _liquidity, 
            position.amountA,
            position.amountB,
            _shouldReturn ? msg.sender : address(this),
            block.timestamp // solhint-disable-line not-rely-on-time
        );
    }

    /**
     * Remove liquidity via the Uniswap V2 Router and swap to a single asset
     *
     * @param  _pool                    Address of liquidity token
     * @param  _component               Address required to remove liquidity
     * @param  _minTokenOut             AmountOut minimum to remove liquidity
     * @param  _liquidity               Liquidity amount to remove
     */
    function removeLiquiditySingleAsset(
        address _pool,
        address _component,
        uint256 _minTokenOut,
        uint256 _liquidity
    )
        external
        returns (
            uint[] memory amounts
        )
    {
        IUniswapV2Pair pair = IUniswapV2Pair(_pool);
        require(factory == IUniswapV2Factory(pair.factory()), "_pool factory doesn't match the router factory");

        address tokenA = pair.token0();
        address tokenB = pair.token1();
        require(tokenA == _component || tokenB == _component, "_pool doesn't contain the _component");
        require(_minTokenOut > 0, "requested token must be greater than 0");
        require(_liquidity > 0, "_liquidity must be greater than 0");

        // Swap them if needed
        if( tokenB == _component ) {
            tokenB = tokenA;
            tokenA = _component;
        }

        // Determine if enough of the token will be received
        uint256 totalSupply = pair.totalSupply();
        (uint256 reserveA, uint256 reserveB) = getReserves(pair, _component);
        uint[] memory receivedTokens = new uint[](2);
        receivedTokens[0] = reserveA.mul(_liquidity).div(totalSupply);
        receivedTokens[1] = reserveB.mul(_liquidity).div(totalSupply);

        address[] memory components = new address[](2);
        components[0] = tokenA;
        components[1] = tokenB;

        (receivedTokens[0], receivedTokens[1]) = removeLiquidity(_pool, components, receivedTokens, _liquidity, false);

        uint256 amountReceived = router.getAmountOut(
            receivedTokens[1],
            reserveB.sub(receivedTokens[1]),
            reserveA.sub(receivedTokens[0])
        );

        require( receivedTokens[0].add(amountReceived) >= _minTokenOut,
            "_minTokenOut is too high for amount received");

        // Approve the router to spend the swap tokens
        IERC20(tokenB).approve(address(router), receivedTokens[1]);

        // Swap the other token for _component
        components[0] = tokenB;
        components[1] = tokenA;
        amounts = router.swapExactTokensForTokens(
            receivedTokens[1],
            amountReceived,
            components,
            address(this),
            block.timestamp // solhint-disable-line not-rely-on-time
        );

        // Send the tokens back to the caller
        IERC20(tokenA).transfer(msg.sender, receivedTokens[0].add(amounts[1]));

    }
}