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

contract CurveRegistryMock {

    address public pool;
    address[8] public tokens;

    constructor(address _pool, address[8] memory _tokens) public {
        pool = _pool;
        tokens = _tokens;
    }

    function get_pool_from_lp_token(address /* _lpToken */) external view returns (address) {
        return pool;
    }

    function get_coins(address /* _pool */) external view returns (address[8] memory) {
        return tokens;
    }
}