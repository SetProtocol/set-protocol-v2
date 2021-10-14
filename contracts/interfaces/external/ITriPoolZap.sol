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

interface ITriPoolZap {
    function add_liquidity(
        address  _pool,
        uint256[4] calldata _depositAmounts,
        uint256 _minMintAmount,
        address _receiver
    ) external returns (uint256);

    function remove_liquidity(
        address _pool,
        uint256 _burnAmount,
        uint256[4] calldata _minAmounts,
        address _receiver
    ) external;

    function remove_liquidity_one_coin(
        address _pool,
        uint256 _burnAmount,
        int128 _i,
        uint256 _minAmount,
        address _receiver
    ) external;
}