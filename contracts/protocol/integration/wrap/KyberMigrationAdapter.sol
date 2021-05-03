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

/**
 * @title KyberMigrationAdapter
 * @author Set Protocol
 *
 * Wrap adapter for one time token migration that returns data for wrapping KNC Legacy into KNC
 */
contract KyberMigrationWrapAdapter {

    /* ============ State Variables ============ */

    // Address of KNC migration contract proxy
    address public immutable kncLegacyToKncMigrationProxy;

    // Address of KNC Legacy token
    address public immutable kncLegacyToken;

    // Address of KNC token
    address public immutable kncToken;

    /* ============ Constructor ============ */

    /**
     * Set state variables
     *
     * @param _kncLegacyToKncMigrationProxy     Address of KNC migration contract proxy
     * @param _kncLegacyToken                   Address of KNC Legacy token
     * @param _kncToken                         Address of KNC token
     */
    constructor(
        address _kncLegacyToKncMigrationProxy,
        address _kncLegacyToken,
        address _kncToken
    )
        public
    {
        kncLegacyToKncMigrationProxy = _kncLegacyToKncMigrationProxy;
        kncLegacyToken = _kncLegacyToken;
        kncToken = _kncToken;
    }

    /* ============ External Getter Functions ============ */

    /**
     * Generates the calldata to migrate KNC Legacy to KNC.
     *
     * @param _underlyingToken      Address of the component to be wrapped
     * @param _wrappedToken         Address of the wrapped component
     * @param _underlyingUnits      Total quantity of underlying units to wrap
     *
     * @return address              Target contract address
     * @return uint256              Total quantity of underlying units (if underlying is ETH)
     * @return bytes                Wrap calldata
     */
    function getWrapCallData(
        address _underlyingToken,
        address _wrappedToken,
        uint256 _underlyingUnits
    )
        external
        view
        returns (address, uint256, bytes memory)
    {
        require(_underlyingToken == kncLegacyToken, "Must be KNC Legacy token");
        require(_wrappedToken == kncToken, "Must be KNC token");

        // mintWithOldKnc(uint256 amount)
        bytes memory callData = abi.encodeWithSignature("mintWithOldKnc(uint256)", _underlyingUnits);

        return (kncLegacyToKncMigrationProxy, 0, callData);
    }

    /**
     * Generates the calldata to unwrap a wrapped asset into its underlying. Note: Migration cannot be reversed. This function
     * will revert.
     *
     * @return address              Target contract address
     * @return uint256              Total quantity of wrapped token units to unwrap. This will always be 0 for unwrapping
     * @return bytes                Unwrap calldata
     */
    function getUnwrapCallData(
        address /* _underlyingToken */,
        address /* _wrappedToken */,
        uint256 /* _wrappedTokenUnits */
    )
        external
        view
        returns (address, uint256, bytes memory)
    {
        revert("KNC migration cannot be reversed");
    }

    /**
     * Returns the address to approve source tokens for wrapping.
     *
     * @return address        Address of the contract to approve tokens to
     */
    function getSpenderAddress(address /* _underlyingToken */, address /* _wrappedToken */) external view returns(address) {
        return kncLegacyToKncMigrationProxy;
    }
}
