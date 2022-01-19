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

contract RgtMigrationWrapAdapter {

    /* ============ State Variables ============ */

    address public immutable rgtToken;
    address public immutable tribeToken;
    address public immutable pegExchanger;

    /* ============ Constructor ============ */

    /**
     * Set state variables
     *
     * @param _rgtToken                           Address of KNC Legacy token
     * @param _tribeToken                         Address of KNC token
     */
    constructor(
        address _rgtToken,
        address _tribeToken,
        address _pegExchanger
    )
        public
    {
        rgtToken = _rgtToken;
        tribeToken = _tribeToken;
        pegExchanger = _pegExchanger;
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
        require(_underlyingToken == rgtToken, "Must be RGT token");
        require(_wrappedToken == _tribeToken, "Must be TRIBE token");

        // exchange(uint256 amount)
        bytes memory callData = abi.encodeWithSignature("exchange(uint256)", _underlyingUnits);

        return (pegExchanger, 0, callData);
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
        revert("RGT migration cannot be reversed");
    }

    /**
     * Returns the address to approve source tokens for wrapping.
     *
     * @return address        Address of the contract to approve tokens to
     */
    function getSpenderAddress(address /* _underlyingToken */, address /* _wrappedToken */) external view returns(address) {
        return pegExchanger;
    }
}