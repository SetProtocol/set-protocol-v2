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

import { IBVault } from "../../../interfaces/external/IBVault.sol";
import { IIndexExchangeAdapter } from "../../../interfaces/IIndexExchangeAdapter.sol";

import { console } from "hardhat/console.sol";

/**
 * @title BalancerV2IndexExchangeAdapter
 * @author Set Protocol
 *
 * A Balancer V2 exchange adapter that returns calldata for trading with GeneralIndexModule, allows trading a fixed input amount or for a fixed
 * output amount.
 */
contract BalancerV2IndexExchangeAdapter is IIndexExchangeAdapter {
    
    /* ============ State Variables ============ */
    
    // Address of Balancer V2 vault contract
    address public immutable vault;

    /* ============ Constructor ============ */

    /**
     * Set state variables
     *
     * @param _vault        balancer vault address
     */
    constructor(address _vault) public {
        vault = _vault;
    }

    /* ============ External Getter Functions ============ */

    /**
     * Return calldata for Balancer Vault, _isSendTokenFixed indicates whether a fixed amount of token should be sold for an unfixed amount, or
     * if an unfixed amount of token should be spent for a fixed amount.
     *
     * Note: When _isSendTokenFixed is false, _sourceQuantity is defined as the max token quantity you are willing to trade, and
     * _destinationQuantity is the exact quantity of token you are receiving.
     *
     * @param  _sourceToken              Address of source token to be sold
     * @param  _destinationToken         Address of destination token to buy
     * @param  _isSendTokenFixed         Boolean indicating if the send quantity is fixed, used to determine correct trade interface
     * @param  _sourceQuantity           Fixed/Max amount of source token to sell
     * @param  _destinationQuantity      Min/Fixed amount of destination tokens to receive
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
        bytes memory _data
    )
        external
        view
        override
        returns (address, uint256, bytes memory)
    {
        bytes32 poolId = abi.decode(_data, (bytes32));

        console.logBytes32(poolId);
        console.log(_destinationAddress);
        console.log(_sourceQuantity);

        IBVault.SingleSwap memory singleSwap = IBVault.SingleSwap({
            poolId: poolId,
            kind: _isSendTokenFixed ? IBVault.SwapKind.GIVEN_IN : IBVault.SwapKind.GIVEN_OUT,
            assetIn: _sourceToken,
            assetOut: _destinationToken,
            amount: _isSendTokenFixed ? _sourceQuantity : _destinationQuantity,
            userData: ""
        });

        console.log("a");

        IBVault.FundManagement memory funds = IBVault.FundManagement({
            sender: _destinationAddress,
            fromInternalBalance: false,
            recipient: payable(_destinationAddress),
            toInternalBalance: false
        });

        console.log("b");
        
        bytes memory callData = abi.encodePacked(
            IBVault.swap.selector,
            abi.encode(
                singleSwap,
                funds,
                _isSendTokenFixed ? _destinationQuantity : _sourceQuantity,
                uint256(-1)
            )
        );

        console.log("c");

        return (vault, 0, callData);
    }

    /**
     * Returns the address to approve source tokens to for trading. This is the Balancer V2 Vault address
     *
     * @return address             Address of the contract to approve tokens to
     */
    function getSpender() external view override returns (address) {
        return vault;
    }
} 