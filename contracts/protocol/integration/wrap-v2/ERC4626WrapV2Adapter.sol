/*
    Copyright 2023 Index Cooperative

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at
    http://www.apache.org/licenses/LICENSE-2.0
    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.

    SPDX-License-Identifier: Apache-2.0	
*/

pragma solidity 0.8.17;

import { IERC4626 } from "../../../interfaces/external/IERC4626.sol";

/**
 * @title ERC4626WrapV2Adapter
 * @author Index Cooperative
 *
 * Wrap adapter for ERC-4626 Vaults that returns data for wraps/unwraps of tokens
 */
contract ERC4626WrapV2Adapter {

    /* ============ External Getter Functions ============ */

    /**
     * Generates the calldata to wrap an underlying asset into a wrappedToken.
     *
     * @param _underlyingToken      Address of the component to be wrapped
     * @param _wrappedToken         Address of the desired wrapped token
     * @param _underlyingUnits      Total quantity of underlying units to wrap
     * @param _to                   Address to send the wrapped tokens to
     *
     * @return address              Target contract address
     * @return uint256              Total quantity of underlying units (if underlying is ETH)
     * @return bytes                Wrap calldata
     */
    function getWrapCallData(
        address _underlyingToken,
        address _wrappedToken,
        uint256 _underlyingUnits,
        address _to,
        bytes memory /* _wrapData */
    )
        external
        view
        returns (address, uint256, bytes memory)
    {
        IERC4626 vault = IERC4626(_wrappedToken);
        require(vault.asset() == _underlyingToken, "Must be a valid token pair");

        bytes memory callData = abi.encodeWithSelector(
            IERC4626.deposit.selector, 
            _underlyingUnits, 
            _to
        );

        return (address(vault), 0, callData);
    }

    /**
     * Generates the calldata to unwrap a wrapped asset into its underlying.
     *
     * @param _underlyingToken      Address of the underlying asset
     * @param _wrappedToken         Address of the component to be unwrapped
     * @param _wrappedTokenUnits    Total quantity of wrapped token units to unwrap
     * @param _to                   Address to send the unwrapped tokens to
     *
     * @return address              Target contract address
     * @return uint256              Total quantity of wrapped token units to unwrap. This will always be 0 for unwrapping
     * @return bytes                Unwrap calldata
     */
    function getUnwrapCallData(
        address _underlyingToken,
        address _wrappedToken,
        uint256 _wrappedTokenUnits,
        address _to,
        bytes memory /* _wrapData */
    )
        external
        view
        returns (address, uint256, bytes memory)
    {
        IERC4626 vault = IERC4626(_wrappedToken);
        require(vault.asset() == _underlyingToken, "Must be a valid token pair");

        bytes memory callData = abi.encodeWithSelector(
            IERC4626.redeem.selector, 
            _wrappedTokenUnits,
            _to,
            _to
        );

        return (address(vault), 0, callData);
    }

    /**
     * Returns the address to approve source tokens for wrapping.
     * 
     * @param _wrappedToken    Address of the ERC-4626 vault
     *
     * @return address         Address of the contract to approve tokens to
     */
    function getSpenderAddress(address /* _underlyingToken */, address  _wrappedToken) external pure returns(address) {
        return _wrappedToken;
    }
}
