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

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

interface ITokenSwap {
    function swapToken() external;    
}

/**
 * @title AxieInfinityMigrationWrapAdapter
 * @author Set Protocol
 *
 * Wrap adapter for one time token migration that returns data for wrapping old AXS token into new AXS token.
 * Note: New AXS token can not be unwrapped into old AXS token, because migration can not be reversed.
 */
contract AxieInfinityMigrationWrapAdapter {

    using SafeERC20 for IERC20;

    /* ============ State Variables ============ */

    // Address of TokenSwap contract which swaps old AXS tokens for new AXS tokens
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
        
        IERC20(_oldToken).safeApprove(_tokenSwap, uint256(-1));
    }

    /* ============ External Functions ============ */

    /**
     * Pulls specified amount of old AXS tokens from the `msg.sender` and swaps them for new AXS tokens 
     * for a 1:1 ratio via the Axie TokenSwap contract. Transfers the received amount of new AXS tokens
     * back to the `msg.sender`
     *
     * @param _amount           Total amount of old AXS tokens to be swapped for new AXS tokens
     */
    function swapToken(uint256 _amount) external {
        IERC20(oldToken).safeTransferFrom(msg.sender, address(this), _amount);
        ITokenSwap(tokenSwap).swapToken();
        IERC20(oldToken).safeTransfer(msg.sender, _amount);
    }


    /* ============ External Getter Functions ============ */

    /**
     * Generates the calldata to migrate old AXS to new AXS.
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
        require(_underlyingToken == oldToken, "Must be old AXS token");
        require(_wrappedToken == newToken, "Must be new AXS token");

        // swapToken()
        bytes memory callData = abi.encodeWithSignature("swapToken(uint256)", [_underlyingUnits]);

        return (address(this), 0, callData);
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
        return address(this);
    }
}
