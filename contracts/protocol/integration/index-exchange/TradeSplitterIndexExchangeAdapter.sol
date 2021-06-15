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

import { IIndexExchangeAdapter } from "../../../interfaces/IIndexExchangeAdapter.sol";

/**
 * @title TradeSplitterIndexExchangeAdapter
 * @author Set Protocol
 *
 * A TradeSplitter exchange adapter that returns calldata for trading with GeneralIndexModule, allows encoding a trade with a fixed input quantity 
 * or a fixed output quantity.
 */
contract TradeSplitterIndexExchangeAdapter is IIndexExchangeAdapter {

    /* ============ Constants ============ */

    // Address of TradeSplitter contract
    address public immutable tradeSplitter;
    // signature of exact input trade
    string public constant EXACT_INPUT = "tradeExactInput(uint256,uint256,address[],address,uint256)";
    // signature of exact output trade
    string public constant EXACT_OUTPUT = "tradeExactOutput(uint256,uint256,address[],address,uint256)";

    /* ============ Constructor ============ */

    /**
     * Set state variables
     *
     * @param _tradeSplitter    Address of TradeSplitter contract
     */
    constructor(address _tradeSplitter) public {
        tradeSplitter = _tradeSplitter;
    }

    /* ============ External Getter Functions ============ */

    /**
     * Return calldata for trading with TradeSplitter. Trade paths are created from input and output tokens, _isSendTokenFixed indicates whether
     * a fixed amount of token should be sold or an unfixed amount.
     *
     * Note: When _isSendTokenFixed is false, _sourceQuantity is defined as the max token quantity you are willing to trade, and
     * _destinationQuantity is the exact quantity of token you are receiving.
     *
     * @param  _sourceToken              Address of source token to be sold
     * @param  _destinationToken         Address of destination token to buy
     * @param  _destinationAddress       Address that assets should be transferred to
     * @param  _isSendTokenFixed         Boolean indicating if the send quantity is fixed, used to determine correct trade interface
     * @param  _sourceQuantity           Fixed/Max amount of source token to sell
     * @param  _destinationQuantity      Min/Fixed amount of destination token to buy
     *
     * @return address                   Target contract address
     * @return uint256                   Call value
     * @return bytes                     Trade calldata
     */
    function getTradeCalldata(
        address _sourceToken,
        address _destinationToken,
        address _destinationAddress,
        bool _isSendTokenFixed,
        uint256 _sourceQuantity,
        uint256 _destinationQuantity,
        bytes memory /*_data*/
    )
        external
        view
        override
        returns (address, uint256, bytes memory)
    {
        address[] memory path = new address[](2);
        path[0] = _sourceToken;
        path[1] = _destinationToken;

        bytes memory callData = abi.encodeWithSignature(
            _isSendTokenFixed ? EXACT_INPUT : EXACT_OUTPUT,
            _sourceQuantity,
            _destinationQuantity,
            path,
            _destinationAddress,
            block.timestamp
        );

        return (tradeSplitter, 0, callData);
    }

    /**
     * Returns the address to approve source tokens to for trading. This is the TradeSplitter address
     *
     * @return address             Address of the contract to approve tokens to
     */
    function getSpender() external view override returns (address) {
        return tradeSplitter;
    }
}
