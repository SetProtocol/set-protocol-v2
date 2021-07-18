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

import { ISetToken } from "../../../../interfaces/ISetToken.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { AaveV2 } from "../../../../protocol/integration/lib/AaveV2.sol";

contract AaveV2Mock {

    /* ============ External ============ */
    
    function testGetDepositCalldata(
        address _asset, 
        uint256 _amountNotional,
        address _onBehalfOf,
        uint16 _referralCode,
        address _lendingPool
    )
        public
        pure
        returns (address, uint256, bytes memory)
    {
        return AaveV2.getDepositCalldata(_asset, _amountNotional, _onBehalfOf, _referralCode, _lendingPool);
    }
    
    function testInvokeDeposit(
        ISetToken _setToken,
        IERC20 _asset,
        uint256 _amountNotional,
        address _lendingPool
    )
        external
    {
        return AaveV2.invokeDeposit(_setToken, _asset, _amountNotional, _lendingPool);
    }
    
    function testGetWithdrawCalldata(
        address _asset, 
        uint256 _amountNotional,
        address _receiver,
        address _lendingPool
    )
        public
        pure
        returns (address, uint256, bytes memory)
    {
        return AaveV2.getWithdrawCalldata(_asset, _amountNotional, _receiver, _lendingPool);
    }
    
    function testInvokeWithdraw(
        ISetToken _setToken,
        IERC20 _asset,
        uint256 _amountNotional,
        address _lendingPool
    )
        external
    {
        return AaveV2.invokeWithdraw(_setToken, _asset, _amountNotional, _lendingPool);
    }
    
    function testGetBorrowCalldata(
        address _asset, 
        uint256 _amountNotional,
        uint256 _interestRateMode,
        uint16 _referralCode,
        address _onBehalfOf,
        address _lendingPool
    )
        public
        pure
        returns (address, uint256, bytes memory)
    {
        return AaveV2.getBorrowCalldata(_asset, _amountNotional, _interestRateMode, _referralCode, _onBehalfOf, _lendingPool);
    }
    
    function testInvokeBorrow(
        ISetToken _setToken,
        IERC20 _asset,
        uint256 _amountNotional,
        uint256 _interestRateMode,
        address _lendingPool
    )
        external
    {
        return AaveV2.invokeBorrow(_setToken, _asset, _amountNotional, _interestRateMode, _lendingPool);
    }

    function testGetRepayCalldata(
        address _asset, 
        uint256 _amountNotional,
        uint256 _interestRateMode,        
        address _onBehalfOf,
        address _lendingPool
    )
        public
        pure
        returns (address, uint256, bytes memory)
    {
        return AaveV2.getRepayCalldata(_asset, _amountNotional, _interestRateMode, _onBehalfOf, _lendingPool);
    }
    
    function testInvokeRepay(
        ISetToken _setToken,
        IERC20 _asset,
        uint256 _amountNotional,
        uint256 _interestRateMode,
        address _lendingPool
    )
        external
    {
        return AaveV2.invokeRepay(_setToken, _asset, _amountNotional, _interestRateMode, _lendingPool);
    }

    function testGetUseReserveAsCollateralCalldata(
        address _asset,
        bool _useAsCollateral,
        address _lendingPool
    )
        external
        pure
        returns (address, uint256, bytes memory)
    {
        return AaveV2.getUseReserveAsCollateralCalldata(_asset, _useAsCollateral, _lendingPool);
    }

    function testInvokeUseAsCollateral(
        ISetToken _setToken,
        IERC20 _asset,
        bool _useAsCollateral,
        address _lendingPool
    )
        external
    {
        return AaveV2.invokeUseAsCollateral(_setToken, _asset, _useAsCollateral, _lendingPool);
    }

    function testGetSwapBorrowRateCalldata(
        address _asset,
        uint256 _rateMode,
        address _lendingPool
    )
        external
        pure
        returns (address, uint256, bytes memory)
    {
        return AaveV2.getSwapBorrowRateCalldata(_asset, _rateMode, _lendingPool);
    }

    function testInvokeSwapBorrowRate(
        ISetToken _setToken,
        IERC20 _asset,
        uint256 _rateMode,
        address _lendingPool
    )
        external
    {
        return AaveV2.invokeSwapBorrowRate(_setToken, _asset, _rateMode, _lendingPool);
    }

    /* ============ Helper Functions ============ */

    function initializeModuleOnSet(ISetToken _setToken) external {
        _setToken.initializeModule();
    }
}