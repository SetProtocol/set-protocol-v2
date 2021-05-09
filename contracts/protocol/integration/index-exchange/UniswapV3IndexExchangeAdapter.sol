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

pragma solidity >=0.7.5;
pragma abicoder v2;

import { ISwapRouter } from  "@uniswap/v3-periphery/contracts/interfaces/ISwapRouter.sol";
import { BytesLib } from "@uniswap/v3-periphery/contracts/libraries/BytesLib.sol";

import { IIndexExchangeAdapter } from "../../../interfaces/IIndexExchangeAdapter.sol";

/**
 * @title UniswapV3IndexExchangeAdapter
 * @author Set Protocol
 *
 * A Uniswap V3 exchange adapter that returns calldata for trading with GeneralIndexModule, allows encoding a trade with a fixed input quantity or
 * a fixed output quantity.
 */
contract UniswapV3IndexExchangeAdapter is IIndexExchangeAdapter {

    using BytesLib for bytes;
    
    /* ============ State Variables ============ */

    // Address of Uniswap V3 SwapRouter contract
    address public immutable router;
    // Uniswap router function string for swapping exact amount of input tokens for a minimum of output tokens
    string internal constant SWAP_EXACT_INPUT = "exactInput((bytes,address,uint256,uint256,uint256))";
    // Uniswap router function string for swapping max amoutn of input tokens for an exact amount of output tokens
    string internal constant SWAP_EXACT_OUTPUT = "exactOutput((bytes,address,uint256,uint256,uint256))";
    
    /* ============ Constructor ============ */

    /**
     * Set state variables
     *
     * @param _router       Address of Uniswap V3 SwapRouter contract
     */
    constructor(address _router) {
        router = _router;
    }

    /* ============ External Getter Functions ============ */

    /**
     * Return calldata for trading with Uniswap V3 SwapRouter. Trade paths are created from input and output tokens, _isSendTokenFixed indicates whether
     * a fixed amount of token should be sold or an unfixed amount.
     *
     * Note: When _isSendTokenFixed is false, _sourceQuantity is defined as the max token quantity you are willing to trade, and
     * _destinationQuantity is the exact quantity of token you are receiving.
     *
     * @param _sourceToken              Address of source token to be sold
     * @param _destinationToken         Address of destination token to buy
     * @param _destinationAddress       Address that assets should be transferred to
     * @param _isSendTokenFixed         Boolean indicating if the send quantity is fixed, used to determine correct trade interface
     * @param _sourceQuantity           Fixed/Max amount of source token to sell
     * @param _destinationQuantity      Min/Fixed amount of destination token to buy
     * @param _data                     Arbitrary bytes containing fees value, expressed in hundredths of a bip, 
     *                                      used to determine the pool to trade among similar asset pools on Uniswap V3
     *
     * @return address                  Target contract address
     * @return uint256                  Call value
     * @return bytes                    Trade calldata
     */
    function getTradeCalldata(
        address _sourceToken,
        address _destinationToken,
        address _destinationAddress,
        bool _isSendTokenFixed,
        uint256 _sourceQuantity,
        uint256 _destinationQuantity,
        bytes memory _data
    )
        external
        view
        override
        returns (address, uint256, bytes memory)
    {   
        uint24 fees = _data.toUint24(0);
        bytes memory path = abi.encodePacked(_sourceToken, fees, _destinationToken);
        
        bytes memory callData = _isSendTokenFixed
            ? abi.encodeWithSignature(
                SWAP_EXACT_INPUT,
                ISwapRouter.ExactInputParams(path, _destinationAddress, block.timestamp, _sourceQuantity, _destinationQuantity)
            ) : abi.encodeWithSignature(
                SWAP_EXACT_OUTPUT,                
                ISwapRouter.ExactOutputParams(path, _destinationAddress, block.timestamp, _destinationQuantity, _sourceQuantity)
            );
        
        return (router, 0, callData);
    }

    /**
     * Returns the address to approve source tokens to for trading. This is the Uniswap router address
     *
     * @return address             Address of the contract to approve tokens to
     */
    function getSpender() external view override returns (address) {
        return router;
    }

    /**
     * Helper that returns the encoded data of trade path.
     *
     * @param _sourceToken             Address of source token to be sold
     * @param _fees                    Fees of the Uniswap V3 pool to be used, expressed in hundredths of a bip
     * @param _destinationToken        Address of destination token to buy
     *
     * @return bytes                   Encoded data used for trading on Uniswap
     */
    function getUniswapEncodedPath(address _sourceToken, uint24 _fees, address _destinationToken) external pure returns (bytes memory) {
        return abi.encodePacked(_sourceToken, _fees, _destinationToken);
    }
} 