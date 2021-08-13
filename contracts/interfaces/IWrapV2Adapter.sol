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
 * @title IWrapV2Adapter
 * @author Set Protocol
 */
interface IWrapV2Adapter {

    function ETH_TOKEN_ADDRESS() external view returns (address);

    function getWrapCallData(
        address _underlyingToken,
        address _wrappedToken,
        uint256 _underlyingUnits,
        address _to,
        bytes memory _wrapData
    ) external view returns (address _subject, uint256 _value, bytes memory _calldata);

    function getUnwrapCallData(
        address _underlyingToken,
        address _wrappedToken,
        uint256 _wrappedTokenUnits,
        address _to,
        bytes memory _unwrapData
    ) external view returns (address _subject, uint256 _value, bytes memory _calldata);

    function getSpenderAddress(address _underlyingToken, address _wrappedToken) external view returns(address);
}