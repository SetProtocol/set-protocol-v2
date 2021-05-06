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

/**
 * @title AxieInfinityMigrationWrapAdapter
 * @author Set Protocol
 *
 * Wrap adapter for one time token migration that returns data for wrapping old AXS token into new AXS token.
 * Note: New AXS token can not be unwrapped into old AXS token, because migration can not be reversed.
 */
contract AxieInfinityMigrationWrapAdapter {

    /* ============ State Variables ============ */

    // Address of contract which swaps old AXS tokens for new AXS tokens
    address public immutable tokenSwap;
    address public immutable oldToken;
    address public immutable newToken;

    /* ============ Constructor ============ */

    /**
     * Set state variables
     *
     * @param _tokenSwap           Address of contract which swaps old AXS tokens for new AXS tokens
     * @param _oldToken            Address of old AXS token
     * @param _newToken            Address of new AXS token
     */
    constructor(
        address _tokenSwap,
        address _oldToken,
        address _newToken
    )
        public
    {
        tokenSwap = _tokenSwap;
        oldToken = _oldToken;
        newToken = _newToken;
    }

    /* ============ External Getter Functions ============ */

    /**
     * Generates the calldata to migrate old AXS to new AXS.
     *
     * @param _underlyingToken      Address of the component to be wrapped
     * @param _wrappedToken         Address of the wrapped component
     *
     * @return address              Target contract address
     * @return uint256              Total quantity of underlying units (if underlying is ETH)
     * @return bytes                Wrap calldata
     */
    function getWrapCallData(
        address _underlyingToken,
        address _wrappedToken,
        uint256 /* _underlyingUnits */
    )
        external
        view
        returns (address, uint256, bytes memory)
    {
        require(_underlyingToken == oldToken, "Must be old AXS token");
        require(_wrappedToken == newToken, "Must be new AXS token");

        // swapToken()
        bytes memory callData = abi.encodeWithSignature("swapToken()");

        return (tokenSwap, 0, callData);
    }

    /**
     * This function will revert, since migration cannot be reversed.
     */
    function getUnwrapCallData(
        address /* _underlyingToken */,
        address /* _wrappedToken */,
        uint256 /* _wrappedTokenUnits */
    )
        external
        pure
        returns (address, uint256, bytes memory)
    {
        revert("AXS migration cannot be reversed");
    }

    /**
     * Returns the address to approve source tokens for wrapping.
     *
     * @return address        Address of the contract to approve tokens to
     */
    function getSpenderAddress(address /* _underlyingToken */, address /* _wrappedToken */) external view returns(address) {
        return tokenSwap;
    }
}
