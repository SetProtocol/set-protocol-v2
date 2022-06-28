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

import { IVelodromeRouter } from "../../../interfaces/external/IVelodromeRouter.sol";

/**
 * @title VelodromeExchangeAdapter
 * @author deephil
 *
 * Exchange adapter for Velodrome Exchange Router that encodes trade data
 */
contract VelodromeExchangeAdapter {

    /* ============ State Variables ============ */

    // Address of Velodrome Exchange Router contract
    address public immutable router;

    /* ============ Constructor ============ */

    /**
     * Set state variables
     *
     * @param _router       Address of Velodrome Exchange Router contract
     */
    constructor(address _router) public {
        router = _router;
    }

    /* ============ External Getter Functions ============ */

    /**
     * Return calldata for Velodrome Exchange Router
     *
     * @param  _sourceToken              Address of source token to be sold
     * @param  _destinationToken         Address of destination token to buy
     * @param  _destinationAddress       Address that assets should be transferred to
     * @param  _sourceQuantity           Amount of source token to sell
     * @param  _minDestinationQuantity   Min amount of destination token to buy
     * @param  _data                     Arbitrary bytes containing trade call data
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
        (
            IVelodromeRouter.route[] memory routes
        ) = abi.decode(_data, (IVelodromeRouter.route[]));

        require(_sourceToken == routes[0].from, "Source token path mismatch");
        require(_destinationToken == routes[routes.length - 1].to, "Destination token path mismatch");

        bytes memory callData = abi.encodeWithSelector(
            IVelodromeRouter.swapExactTokensForTokens.selector,
            _sourceQuantity,
            _minDestinationQuantity,
            routes,
            _destinationAddress,
            block.timestamp
        );
        return (router, 0, callData);
    }

    /**
     * Returns the address to approve source tokens to for trading. This is the Velodrome Exchange Router address
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

    /**
     * Generate data parameter to be passed to `getTradeCallData`. Returns encoded trade routes.
     *
     * @param _routes          array of routes for Velodrome Router
     * @return bytes                Data parameter to be passed to `getTradeCallData`
     */
    function generateDataParam(IVelodromeRouter.route[] calldata _routes)
        external
        pure
        returns (bytes memory)
    {
        return abi.encode(_routes);
    }
} 