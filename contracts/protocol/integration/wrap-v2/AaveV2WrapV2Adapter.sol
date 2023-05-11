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

import { IAToken } from "../../../interfaces/external/aave-v2/IAToken.sol";
import { ILendingPool } from "../../../interfaces/external/aave-v2/ILendingPool.sol";
import { IWETHGateway } from "../../../interfaces/external/aave-v2/IWETHGateway.sol";

/**
 * @title AaveV2WrapV2Adapter
 * @author Set Protocol
 *
 * Wrap adapter for Aave V2 that returns data for wraps/unwraps of tokens
 * Note if this contract is used on other chains, simply think of "ETH" support as support for the native coin
 * e.g. MATIC / AVAX, for which Aave also only uses the wrapped versions, easily usable through the gateway contract
 */
contract AaveV2WrapV2Adapter {

    /* ============ Constants ============ */

    // Mock address to indicate ETH. Aave V2 only supports WETH but provides a WETHGateway which handles everything
    address public constant ETH_TOKEN_ADDRESS = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /* ============ Modifiers ============ */

    /**
     * Throws if the underlying/wrapped token pair is not valid
     */
    modifier _onlyValidTokenPair(address _underlyingToken, address _wrappedToken) {
        require(validTokenPair(_underlyingToken, _wrappedToken), "Must be a valid token pair");
        _;
    }

    /* ========== State Variables ========= */

    // Address of the Aave LendingPool contract
    // Note: this address should refer to the proxy contract, even if the lending pool changes, the proxy address stays the same
    ILendingPool public immutable lendingPool;
    // Address of the WETH Gateway, provided by Aave to handle direct ETH deposits / withdraws (handling wrapping to WETH)
    IWETHGateway public immutable wethGateway;
    // Aave only supports WETH, the address is used to replace ETH_TOKEN_ADDRESS for valid pair checks
    address public immutable weth;

    /* ============ Constructor ============ */

    constructor(ILendingPool _lendingPool, IWETHGateway _wethGateway, address _weth) public {
        lendingPool = _lendingPool;
        wethGateway = _wethGateway;
        weth = _weth;
    }

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
        _onlyValidTokenPair(_underlyingToken, _wrappedToken)
        returns (address, uint256, bytes memory)
    {
        uint256 value;
        bytes memory callData;
        address callTarget;
        if (_underlyingToken == ETH_TOKEN_ADDRESS) {
            value = _underlyingUnits;
            callTarget = address(wethGateway);
            // Aave V2 provides a "WETHGateway" contract which wraps ETH -> WETH and deposits for aWETH
            callData = abi.encodeWithSignature(
                "depositETH(address,address,uint16)",
                address(lendingPool),
                _to,
                0
            );
        } else {
            callTarget = address(lendingPool);
            callData = abi.encodeWithSignature(
                "deposit(address,uint256,address,uint16)",
                _underlyingToken,
                _underlyingUnits,
                _to,
                0
            );
        }

        return (callTarget, value, callData);
    }

    /**
     * Generates the calldata to unwrap a wrapped asset into its underlying.
     *
     * @param _underlyingToken      Address of the underlying asset
     * @param _wrappedToken         Address of the component to be unwrapped
     * @param _wrappedTokenUnits    Total quantity of wrapped token units to unwrap
     *      - Note that aTokens are rebasing and hold a 1:1 peg with underlying. So _wrappedTokenUnits = underlying token units
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
        _onlyValidTokenPair(_underlyingToken, _wrappedToken)
        returns (address, uint256, bytes memory)
    {
        bytes memory callData;
        address callTarget;
        if (_underlyingToken == ETH_TOKEN_ADDRESS) {
            callTarget = address(wethGateway);
            // Aave V2 provides a "WETHGateway" contract which withdraws aWETH and unwraps WETH -> ETH
            callData = abi.encodeWithSignature(
                "withdrawETH(address,uint256,address)",
                address(lendingPool),
                _wrappedTokenUnits,
                _to
            );
        } else {
            callTarget = address(lendingPool);
            callData = abi.encodeWithSignature(
                "withdraw(address,uint256,address)",
                _underlyingToken,
                _wrappedTokenUnits,
                _to
            );
        }

        return (callTarget, 0, callData);
    }

    /**
     * Returns the address to approve source tokens for wrapping.
     *
     * @return address        Address of the contract to approve tokens to
     */
    function getSpenderAddress(address /* _underlyingToken */, address  /* _wrappedToken */) external view returns(address) {
        return address(lendingPool);
    }

    /* ============ Internal Functions ============ */

    /**
     * Validates the underlying and wrapped token pair
     *
     * @param _underlyingToken     Address of the underlying asset
     * @param _wrappedToken        Address of the wrapped asset
     *
     * @return bool                Whether or not the wrapped token accepts the underlying token as collateral
     */
    function validTokenPair(address _underlyingToken, address _wrappedToken) internal view returns(bool) {
        if(_underlyingToken == ETH_TOKEN_ADDRESS) {
            _underlyingToken = weth;
        }
        return IAToken(_wrappedToken).UNDERLYING_ASSET_ADDRESS() == _underlyingToken;
    }
}