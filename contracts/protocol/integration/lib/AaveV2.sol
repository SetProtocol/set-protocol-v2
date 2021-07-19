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

import { ISetToken } from "../../../interfaces/ISetToken.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// TODO: Calculate the gas costs of having separate getter functions.

/**
 * @title AaveV2
 * @author Set Protocol
 * 
 * Collection of helper functions for interacting with AaveV2 integrations.
 */
library AaveV2 {
    /* ============ External ============ */
    
    /**
     * Get deposit calldata from SetToken
     */
    function getDepositCalldata(
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
        bytes memory callData = abi.encodeWithSignature(
            "deposit(address,uint256,address,uint16)", 
            _asset, 
            _amountNotional, 
            _onBehalfOf,
            _referralCode
        );
        
        return (_lendingPool, 0, callData);
    }
    
    /**
     * Invoke deposit on LendingPool from SetToken
     */
    function invokeDeposit(
        ISetToken _setToken,
        IERC20 _asset,
        uint256 _amountNotional,
        address _lendingPool
    )
        external
    {
        ( , , bytes memory depositCalldata) = getDepositCalldata(
            address(_asset), 
            _amountNotional, 
            address(_setToken), 
            0, 
            _lendingPool
        );
        
        _setToken.invoke(_lendingPool, 0, depositCalldata);
    }
    
    /**
     * Get withdraw calldata from SetToken
     */
    function getWithdrawCalldata(
        address _asset, 
        uint256 _amountNotional,
        address _receiver,
        address _lendingPool
    )
        public
        pure
        returns (address, uint256, bytes memory)
    {
        bytes memory callData = abi.encodeWithSignature(
            "withdraw(address,uint256,address)", 
            _asset, 
            _amountNotional, 
            _receiver
        );
        
        return (_lendingPool, 0, callData);
    }
    
    /**
     * Invoke withdraw on LendingPool from SetToken
     */
    function invokeWithdraw(
        ISetToken _setToken,
        IERC20 _asset,
        uint256 _amountNotional,
        address _lendingPool
    )
        external
    {
        ( , , bytes memory withdrawCalldata) = getWithdrawCalldata(
            address(_asset),
            _amountNotional, 
            address(_setToken),
            _lendingPool
        );
        
        _setToken.invoke(_lendingPool, 0, withdrawCalldata);
    }
    
    /**
     * Get borrow calldata from SetToken
     */
    function getBorrowCalldata(
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
        bytes memory callData = abi.encodeWithSignature(
            "borrow(address,uint256,uint256,uint16,address)", 
            _asset, 
            _amountNotional, 
            _interestRateMode,
            _referralCode,
            _onBehalfOf
        );
        
        return (_lendingPool, 0, callData);
    }
    
    /**
     * Invoke borrow on LendingPool from SetToken
     */
    function invokeBorrow(
        ISetToken _setToken,
        IERC20 _asset,
        uint256 _amountNotional,
        uint256 _interestRateMode,
        address _lendingPool
    )
        external
    {
        ( , , bytes memory borrowCalldata) = getBorrowCalldata(
            address(_asset),
            _amountNotional,
            _interestRateMode,
            0, 
            address(_setToken),
            _lendingPool
        );
        
        _setToken.invoke(_lendingPool, 0, borrowCalldata);
    }

    /**
     * Get repay calldata from SetToken
     */
    function getRepayCalldata(
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
        bytes memory callData = abi.encodeWithSignature(
            "repay(address,uint256,uint256,address)", 
            _asset, 
            _amountNotional, 
            _interestRateMode,            
            _onBehalfOf
        );
        
        return (_lendingPool, 0, callData);
    }

    /**
     * Invoke repay on LendingPool from SetToken
     */
    function invokeRepay(
        ISetToken _setToken,
        IERC20 _asset,
        uint256 _amountNotional,
        uint256 _interestRateMode,
        address _lendingPool
    )
        external
    {
        ( , , bytes memory repayCalldata) = getRepayCalldata(
            address(_asset),
            _amountNotional,
            _interestRateMode,
            address(_setToken),
            _lendingPool
        );
        
        _setToken.invoke(_lendingPool, 0, repayCalldata);
    }

    /**
     * Get setUserUseReserveAsCollateral calldata from SetToken
     */
    function getUseReserveAsCollateralCalldata(
        address _asset,
        bool _useAsCollateral,
        address _lendingPool
    )
        public
        pure
        returns (address, uint256, bytes memory)
    {
        bytes memory callData = abi.encodeWithSignature(
            "setUserUseReserveAsCollateral(address,bool)", 
            _asset,
            _useAsCollateral
        );
        
        return (_lendingPool, 0, callData);
    }

    /**
     * Invoke an asset to be used as collateral on Aave from SetToken
     */
    function invokeUseReserveAsCollateral(
        ISetToken _setToken,
        IERC20 _asset,
        bool _useAsCollateral,
        address _lendingPool
    )
        external
    {
        ( , , bytes memory callData) = getUseReserveAsCollateralCalldata(
            address(_asset),
            _useAsCollateral,
            _lendingPool
        );
        
        _setToken.invoke(_lendingPool, 0, callData);
    }
    
    /**
     * Get swapBorrowRate calldata from SetToken
     */
    function getSwapBorrowRateModeCalldata(
        address _asset,
        uint256 _rateMode,
        address _lendingPool
    )
        public
        pure
        returns (address, uint256, bytes memory)
    {
        bytes memory callData = abi.encodeWithSignature(
            "swapBorrowRateMode(address,uint256)", 
            _asset,
            _rateMode
        );
        
        return (_lendingPool, 0, callData);
    }

    /**
     * Invoke to swap borrow rate of SetToken
     * Note: Aave allows a borrower to toggle his debt between stable and variable mode
     */
    function invokeSwapBorrowRateMode(
        ISetToken _setToken,
        IERC20 _asset,
        uint256 _rateMode,
        address _lendingPool
    )
        external
    {
        ( , , bytes memory callData) = getSwapBorrowRateModeCalldata(
            address(_asset),
            _rateMode,
            _lendingPool
        );
        
        _setToken.invoke(_lendingPool, 0, callData);
    }
}