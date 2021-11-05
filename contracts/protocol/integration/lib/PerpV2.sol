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
pragma experimental ABIEncoderV2;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IClearingHouse } from "../../../interfaces/external/perp-v2/IClearingHouse.sol";
import { IVault } from "../../../interfaces/external/perp-v2/IVault.sol";
import { IQuoter } from "../../../interfaces/external/perp-v2/IQuoter.sol";
import { ISetToken } from "../../../interfaces/ISetToken.sol";

/**
 * @title PerpV2
 * @author Set Protocol
 *
 * Collection of helper functions for interacting with PerpV2 integrations.
 */
library PerpV2 {

    /* ============ External ============ */

    function getDepositCalldata(
        IVault _vault,
        IERC20 _asset,
        uint256 _amountNotional
    )
        public
        pure
        returns (address, uint256, bytes memory)
    {
        bytes memory callData = abi.encodeWithSignature(
            "deposit(address,uint256)",
            _asset,
            _amountNotional
        );

        return (address(_vault), 0, callData);
    }

    function invokeDeposit(
        ISetToken _setToken,
        IVault _vault,
        IERC20 _asset,
        uint256 _amountNotional
    )
        external
    {
        ( , , bytes memory depositCalldata) = getDepositCalldata(
            _vault,
            _asset,
            _amountNotional
        );

        _setToken.invoke(address(_vault), 0, depositCalldata);
    }

    function getWithdrawCalldata(
        IVault _vault,
        IERC20 _asset,
        uint256 _amountNotional
    )
        public
        pure
        returns (address, uint256, bytes memory)
    {
        bytes memory callData = abi.encodeWithSignature(
            "withdraw(address,uint256)",
            _asset,
            _amountNotional
        );

        return (address(_vault), 0, callData);
    }

    function invokeWithdraw(
        ISetToken _setToken,
        IVault _vault,
        IERC20 _asset,
        uint256 _amountNotional
    )
        external
    {
        ( , , bytes memory withdrawCalldata) = getWithdrawCalldata(
            _vault,
            _asset,
            _amountNotional
        );

        _setToken.invoke(address(_vault), 0, withdrawCalldata);
    }

    function getOpenPositionCalldata(
        IClearingHouse _clearingHouse,
        IClearingHouse.OpenPositionParams memory _params
    )
        public
        pure
        returns (address, uint256, bytes memory)
    {
        bytes memory callData = abi.encodeWithSignature(
            "openPosition((address,bool,bool,uint256,uint256,uint256,uint160,bytes32))",
            _params
        );

        return (address(_clearingHouse), 0, callData);
    }

    function invokeOpenPosition(
        ISetToken _setToken,
        IClearingHouse _clearingHouse,
        IClearingHouse.OpenPositionParams memory _params
    )
        external
        returns (uint256 deltaBase, uint256 deltaQuote)
    {
        ( , , bytes memory openPositionCalldata) = getOpenPositionCalldata(
            _clearingHouse,
            _params
        );

        bytes memory returnValue = _setToken.invoke(address(_clearingHouse), 0, openPositionCalldata);
        return abi.decode(returnValue, (uint256,uint256));
    }

    function getSwapCalldata(
        IQuoter _quoter,
        IQuoter.SwapParams memory _params
    )
        public
        pure
        returns (address, uint256, bytes memory)
    {
        bytes memory callData = abi.encodeWithSignature(
            "swap((address,bool,bool,uint256,uint160))",
            _params
        );

        return (address(_quoter), 0, callData);
    }

    function invokeSwap(
        ISetToken _setToken,
        IQuoter _quoter,
        IQuoter.SwapParams memory _params
    )
        external
        returns (IQuoter.SwapResponse memory)
    {
        ( , , bytes memory swapCalldata) = getSwapCalldata(
            _quoter,
            _params
        );

        bytes memory returnValue = _setToken.invoke(address(_quoter), 0, swapCalldata);
        return abi.decode(returnValue, (IQuoter.SwapResponse));
    }
}
