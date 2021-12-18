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
 * @title DgV2WrapV2Adapter
 * @author Set Protocol
 *
 * Wrap adapter for one time token migration from DG V1 to DG V2.
 * Note: DG V2 cannot be unwrapped into DG V1, because the migration cannot be reversed.
 */
contract DgMigrationWrapV2Adapter {

    /* ============ State Variables ============ */

    address public immutable dgLegacyToken;
    address public immutable dgToken;

    /* ============ Constructor ============ */

    /**
     * Set state variables
     * @param _dgLegacyToken            Address of DG legacy token
     * @param _dgToken                  Address of DG token
     */
    constructor(address _dgLegacyToken, address _dgToken) public {
        dgLegacyToken = _dgLegacyToken;
        dgToken = _dgToken;
    }

    /* ============ External Getter Functions ============ */

    /**
     * Generates the calldata to migrate DG legacy tokens to DG token.
     */
    function getWrapCallData(
        address _underlyingToken,
        address _wrappedToken,
        uint256 _underlyingUnits
    ) external view returns (address, uint256, bytes memory) {
        require(_underlyingToken == dgLegacyToken, "Must be legacy DG token");
        require(_wrappedToken == dgToken, "Must be new DG token");

        // goLight(uint256)
        bytes memory callData = abi.encodeWithSignature("goLight(uint256)", [_underlyingUnits]);

        // The target contract is the new token contract.
        return (dgToken, 0, callData);
    }

    /**
     * This function will revert, since migration cannot be reversed.
     */
    function getUnwrapCallData(
        address /* _underlyingToken */,
        address /* _wrappedToken */,
        uint256 /* _wrappedTokenUnits */
    ) external pure returns (address, uint256, bytes memory) {
        revert("DG migration cannot be reversed");
    }

    /**
     * Returns the address to approve source tokens for wrapping.
     *
     * @return address        Address of the contract to approve tokens to
     */
    function getSpenderAddress(address /* _underlyingToken */, address /* _wrappedToken */) external view returns (address) {
        return dgToken;
    }
}
