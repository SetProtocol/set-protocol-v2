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
 * @title SushiBarWrapAdapter
 * @author Yam Finance, Set Protocol
 *
 * Wrap adapter for depositing/withdrawing Sushi to/from SushiBar (xSushi)
 */
contract SushiBarWrapAdapter {

    /* ============ State Variables ============ */

    // Address of SUSHI token
    address public immutable sushiToken;

    // Address of xSUSHI token
    address public immutable xSushiToken;

    /* ============ Constructor ============ */

    /**
     * Set state variables
     *
     * @param _sushiToken                      Address of SUSHI token
     * @param _xSushiToken                     Address of xSUSHI token
     */
    constructor(address _sushiToken, address _xSushiToken) public {
        sushiToken = _sushiToken;
        xSushiToken = _xSushiToken;
    }

    /* ============ External Functions ============ */

    /**
     * Generates the calldata to wrap Sushi into xSushi.
     *
     * @param _underlyingToken      Address of SUSHI token
     * @param _wrappedToken         Address of xSUSHI token
     * @param _underlyingUnits      Total quantity of SUSHI units to wrap
     *
     * @return address              Target contract address
     * @return uint256              Unused, always 0
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
        _validateWrapInputs(_underlyingToken, _wrappedToken);

        // Signature for wrapping in xSUSHI is enter(uint256 _amount)
        bytes memory callData = abi.encodeWithSignature("enter(uint256)", _underlyingUnits);

        return (xSushiToken, 0, callData);
    }

    /**
     * Generates the calldata to unwrap xSushi to Sushi
     *
     * @param _underlyingToken      Address of SUSHI token
     * @param _wrappedToken         Address of xSUSHI token
     * @param _wrappedTokenUnits    Total quantity of xSUSHI units to unwrap
     *
     * @return address              Target contract address
     * @return uint256              Unused, always 0
     * @return bytes                Unwrap calldata
     */
    function getUnwrapCallData(
        address _underlyingToken,
        address _wrappedToken,
        uint256 _wrappedTokenUnits
    )
        external
        view
        returns (address, uint256, bytes memory)
    {
        _validateWrapInputs(_underlyingToken, _wrappedToken);

        // Signature for unwrapping in xSUSHI is leave(uint256 _amount)
        bytes memory callData = abi.encodeWithSignature("leave(uint256)", _wrappedTokenUnits);

        return (xSushiToken, 0, callData);

    }

    /**
     * Returns the address to approve source tokens for wrapping.
     *
     * @return address        Address of the contract to approve tokens to. This is the SushiBar (xSushi) contract.
     */
    function getSpenderAddress(address /*_underlyingToken*/, address /*_wrappedToken*/) external view returns(address) {
        return address(xSushiToken);
    }

    /* ============ Internal Functions ============ */

    /**
     * Validate inputs prior to getting wrap and unwrap calldata.
     * 
     * @param _underlyingToken      Address of SUSHI token
     * @param _wrappedToken         Address of xSUSHI token
     */
    function _validateWrapInputs(address _underlyingToken, address _wrappedToken) internal view {
        require(_underlyingToken == sushiToken, "Underlying token must be SUSHI");
        require(_wrappedToken == xSushiToken, "Wrapped token must be xSUSHI");
    }
}