/*
    Copyright 2022 Set Labs Inc.

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

import { IController } from "../../interfaces/IController.sol";
import { IPerpV2LeverageModule } from "../../interfaces/IPerpV2LeverageModule.sol";
import { ISetToken } from "../../interfaces/ISetToken.sol";
import { SlippageIssuanceModule } from "./SlippageIssuanceModule.sol";

/**
 * @title PerpProtocolIssuanceModule
 * @author Set Protocol
 *
 * The IssuanceModule is a module that enables users to issue and redeem SetTokens that contain default and 
 * non-debt external Positions. Managers are able to set an external contract hook that is called before an
 * issuance is called.
 */
contract PerpProtocolIssuanceModule is SlippageIssuanceModule {

    IPerpV2LeverageModule public perpModule;

    constructor(
        IController _controller,
        IPerpV2LeverageModule _perpModule
    )
        public
        SlippageIssuanceModule(_controller)
    {
        perpModule = _perpModule;
    }

    /* ============ External Getter Functions ============ */

    function getSetTokenIssuanceMax(ISetToken _setToken) external view returns(uint256) {
        return perpModule.getMaximumSetTokenIssueAmount(_setToken);
    }
}