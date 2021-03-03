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

/**
 * @title UniswapV2ExchangeAdapter02
 * @author Set Protocol
 *
 * A Uniswap Router02 exchange adapter that returns calldata for trading. Includes option for 2 different trade types on Uniswap
 *
 * CHANGE LOG:
 * - Add ability to choose whether to swap an exact amount of source token for a min amount of receive token or swap a max amount of source token for
 * an exact amount of receive token
 *
 */
contract UniswapV2ExchangeAdapter02 {

    /* ============ State Variables ============ */

    // Address of Uniswap V2 Router02 contract
    address public immutable router;
    // Uniswap router function string for swapping exact tokens for a minimum of receive tokens
    string internal constant SWAP_EXACT_TOKENS_FOR_TOKENS = "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)";
    // Uniswap router function string for swapping tokens for an exact amount of receive tokens
    string internal constant SWAP_TOKENS_FOR_EXACT_TOKENS = "swapTokensForExactTokens(uint256,uint256,address[],address,uint256)";

    /* ============ Constructor ============ */

    /**
     * Set state variables
     *
     * @param _router       Address of Uniswap V2 Router02 contract
     */
    constructor(address _router) public {
        router = _router;
    }

    /* ============ External Getter Functions ============ */

    /**
     * Return calldata for Uniswap V2 Router02. Custom trade paths and bool to select trade function are encoded in the arbitrary data parameter.
     * If data is 0, use default trade path and swap function. If using custom trade path on Uniswap, must also encode boolean to select trade
     * function to call. Similarly, if only using the swap for exact token function, then must also encode trade path.
     *
     * Note: When selecting the swap for exact tokens function, _sourceQuantity is defined as the max token quantity you are willing to trade, and
     * _minDestinationQuantity is the exact quantity of token you are receiving.
     *
     * @param  _sourceToken              Address of source token to be sold
     * @param  _destinationToken         Address of destination token to buy
     * @param  _destinationAddress       Address that assets should be transferred to
     * @param  _sourceQuantity           Amount of source token to sell
     * @param  _minDestinationQuantity   Min amount of destination token to buy
     * @param  _data                     Arbitrary bytes containing additional trade settings
     *
     * @return address                   Target contract address
     * @return uint256                   Call value
     * @return bytes                     Trade calldata
     */
    function getTradeCalldata(
        address _sourceToken,
        address _destinationToken,
        address _destinationAddress,
        uint256 _sourceQuantity,
        uint256 _minDestinationQuantity,
        bytes memory _data
    )
        external
        view
        returns (address, uint256, bytes memory)
    {   
        address[] memory path;
        bool shouldSwapForExactTokens;

        if(_data.length == 0){
            path = new address[](2);
            path[0] = _sourceToken;
            path[1] = _destinationToken;

            // Default setting is to use swapExactTokensForTokens(uint256,uint256,address[],address,uint256)
            shouldSwapForExactTokens = false;
        } else {
            (path, shouldSwapForExactTokens) = abi.decode(_data, (address[],bool));
        }

        // If shouldSwapForExactTokens, then use appropriate function string and flip input quantities
        bytes memory callData = abi.encodeWithSignature(
            shouldSwapForExactTokens ? SWAP_TOKENS_FOR_EXACT_TOKENS : SWAP_EXACT_TOKENS_FOR_TOKENS,
            shouldSwapForExactTokens ? _minDestinationQuantity : _sourceQuantity,
            shouldSwapForExactTokens ? _sourceQuantity : _minDestinationQuantity,
            path,
            _destinationAddress,
            block.timestamp
        );
        return (router, 0, callData);
    }

    /**
     * Returns the address to approve source tokens to for trading. This is the Uniswap router address
     *
     * @return address             Address of the contract to approve tokens to
     */
    function getSpender()
        external
        view
        returns (address)
    {
        return router;
    }
} 