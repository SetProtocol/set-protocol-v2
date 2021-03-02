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

import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";

/**
 * @title SignedMath
 * @author Set Protocol
 *
 * Utility functions to handle int256
 */
library SignedMath {
    using SafeCast for int256;

    /**
     * Returns the absolute value of the signed integer value
     * @param _a Signed interger value
     * @return Returns the absolute value in uint256
     */
    function abs(int256 _a) internal pure returns(uint256) {
        return _a >= 0 ? _a.toUint256() : (-_a).toUint256();
    }
}