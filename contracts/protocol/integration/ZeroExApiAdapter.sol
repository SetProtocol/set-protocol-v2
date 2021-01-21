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
 * @title ZeroExApiAdapter
 * @author Set Protocol
 *
 * Exchange adapter for 0xAPI that returns data for swaps
 */

contract ZeroExApiAdapter {

    /* ============ State Variables ============ */

    // Address of the deployed ZeroEx contract.
    address public immutable zeroExAddress;

    // Returns the address to approve source tokens to for trading. This is the TokenTaker address
    address public immutable getSpender;

    /* ============ constructor ============ */

    constructor(address _zeroExAddress) public {
        zeroExAddress = _zeroExAddress;
        getSpender = _zeroExAddress;
    }


    /* ============ External Getter Functions ============ */

    /**
     * Return 0xAPI calldata which is already generated from 0xAPI
     *
     * @param  _sourceToken              Address of source token to be sold
     * @param  _destinationToken         Address of destination token to buy
     * @param  _destinationAddress       Address that assets should be transferred to
     * @param  _sourceQuantity           Amount of source token to sell
     * @param  _minDestinationQuantity   Min amount of destination token to buy
     * @param  _data                     Arbitrage bytes containing trade call data
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
        bytes calldata _data
    )
        external
        view
        returns (address, uint256, bytes memory)
    {
        // solium-disable security/no-inline-assembly
        address inputToken;
        address outputToken;
        address recipient;
        bool supportsRecipient;
        uint256 inputTokenAmount;
        uint256 minOutputTokenAmount;

        {
            require(_data.length >= 4, "Invalid calldata");
            bytes4 selector;
            assembly {
                selector := and(
                    // Read the first 4 bytes of the _data array from calldata.
                    calldataload(add(36, calldataload(164))), // 164 = 5 * 32 + 4
                    0xffffffff00000000000000000000000000000000000000000000000000000000
                )
            }

            if (selector == 0x415565b0) {
                // transformERC20()
                (inputToken, outputToken, inputTokenAmount, minOutputTokenAmount) =
                    abi.decode(_data[4:], (address, address, uint256, uint256));
            } else if (selector == 0xf7fcd384) {
                // sellToLiquidityProvider()
                (inputToken, outputToken, , recipient, inputTokenAmount, minOutputTokenAmount) =
                    abi.decode(_data[4:], (address, address, address, address, uint256, uint256));
                supportsRecipient = true;
            } else if (selector == 0xd9627aa4) {
                // sellToUniswap()
                address[] memory path;
                (path, inputTokenAmount, minOutputTokenAmount) =
                    abi.decode(_data[4:], (address[], uint256, uint256));
                require(path.length > 1, "Uniswap token path too short");
                inputToken = path[0];
                outputToken = path[path.length - 1];
            } else {
                revert("Unsupported 0xAPI function selector");
            }
        }

        require(inputToken == _sourceToken, "Mismatched input token");
        require(outputToken == _destinationToken, "Mismatched output token");
        require(!supportsRecipient || recipient == _destinationAddress, "Mismatched recipient");
        require(inputTokenAmount == _sourceQuantity, "Mismatched input token quantity");
        require(minOutputTokenAmount >= _minDestinationQuantity, "Mismatched output token quantity");

        return (
            zeroExAddress,
            0, // callValue cannot be determined from calldata.
            _data
        );
    }
}
