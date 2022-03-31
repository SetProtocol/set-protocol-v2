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

import { BytesLib } from "../../../../external/contracts/uniswap/v3/lib/BytesLib.sol";
import { ISwapRouter } from "../../../interfaces/external/ISwapRouter.sol";

/**
 * @title UniswapV3ExchangeAdapterV2
 * @author Set Protocol
 *
 * Exchange adapter for Uniswap V3 SwapRouter that encodes trade data.
 *
 * CHANGE LOG:
 * - Generalized ability to choose whether to swap an exact amount of source token for a min amount of
 * receive token or swap a max amount of source token for an exact amount of receive token.
 */
contract UniswapV3ExchangeAdapterV2 {

    using BytesLib for bytes;

    /* ============ State Variables ============ */

    // Address of Uniswap V3 SwapRouter contract
    address public immutable swapRouter;

    /* ============ Constructor ============ */

    /**
     * Set state variables
     *
     * @param _swapRouter    Address of Uniswap V3 SwapRouter
     */
    constructor(address _swapRouter) public {
        swapRouter = _swapRouter;
    }

    /* ============ External Getter Functions ============ */

    /**
     * Return calldata for Uniswap V3 SwapRouter
     *
     * @param  _sourceToken              Address of source token to be sold
     * @param  _destinationToken         Address of destination token to buy
     * @param  _destinationAddress       Address that assets should be transferred to
     * @param  _sourceQuantity           Fixed/Max amount of source token to sell
     * @param  _destinationQuantity      Min/Fixed amount of destination token to buy
     * @param  _data                     Bytes containing trade path and bool to determine function string.
     *                                   Equals the output of the generateDataParam function
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
        uint256 _destinationQuantity,
        bytes calldata _data
    )
        external
        view
        returns (address, uint256, bytes memory)
    {
        // 20 bytes (_sourceToken address) + 3 bytes (UniV3 fees tier)
        // + 20 bytes (_destinationToken address) + 1 byte (bool to determine fixed input/output)
        require(_data.length == 44, "Invalid data");

        address sourceFromPath = _data.toAddress(0);
        require(_sourceToken == sourceFromPath, "Source token path mismatch");

        address destinationFromPath = _data.toAddress(23);      // 20 bytes (sourceFromPath) + 3 bytes (fees)
        require(_destinationToken == destinationFromPath, "Destination token path mismatch");

        bytes memory pathData = _data.slice(0, _data.length - 1);       // Extract path data from `_data`

        bool fixInput = _toBool(_data, _data.length - 1);        // `fixInput` bool is stored at last byte

        bytes memory callData = fixInput
            ? abi.encodeWithSelector(
                ISwapRouter.exactInput.selector,
                ISwapRouter.ExactInputParams(
                    pathData,
                    _destinationAddress,
                    block.timestamp,
                    _sourceQuantity,
                    _destinationQuantity
                )
            )
            : abi.encodeWithSelector(
                ISwapRouter.exactOutput.selector,
                ISwapRouter.ExactOutputParams(
                    pathData,
                    _destinationAddress,
                    block.timestamp,
                    _destinationQuantity,       // swapped vs exactInputParams
                    _sourceQuantity
                )
            );

        return (swapRouter, 0, callData);
    }

    /**
     * Returns the address to approve source tokens to for trading. This is the Uniswap SwapRouter address
     *
     * @return address             Address of the contract to approve tokens to
     */
    function getSpender() external view returns (address) {
        return swapRouter;
    }

    /**
     * Returns the appropriate _data argument for getTradeCalldata. Equal to the encodePacked path with the
     * fee of each hop between it, e.g [token1, fee1, token2, fee2, token3]. Note: _fees.length == _path.length - 1
     *
     * @param _path array of addresses to use as the path for the trade
     * @param _fees array of uint24 representing the pool fee to use for each hop
     * @param _fixIn Boolean indicating if input amount is fixed
     *
     * @return bytes  Bytes containing trade path and bool to determine function string.
     */
    function generateDataParam(
        address[] calldata _path,
        uint24[] calldata _fees,
        bool _fixIn
    ) external pure returns (bytes memory) {
        bytes memory data = "";
        for (uint256 i = 0; i < _path.length - 1; i++) {
            data = abi.encodePacked(data, _path[i], _fees[i]);
        }

        // Last encode has no fee associated with it since _fees.length == _path.length - 1
        data = abi.encodePacked(data, _path[_path.length - 1]);

        // Encode fixIn
        return abi.encodePacked(data, _fixIn);
    }

    /**
     * Helper function to decode bytes to boolean. Similar to functions found in BytesLib.
     */
    function _toBool(bytes memory _bytes, uint256 _start) internal pure returns (bool) {
        // Don't need these checks, because we have assured `_bytes` is of length 44 in the calling function
        // require(_start + 1 >= _start, "toBool_overflow");
        // require(_bytes.length >= _start + 1, "toBool_outOfBounds");
        uint8 tempUint;

        assembly {
            tempUint := mload(add(add(_bytes, 0x1), _start))
        }

        require(tempUint <= 1, "Invalid bool data");     // Should be either 0 or 1

        return (tempUint == 0) ? false : true;
    }
}