/*
    Copyright 2023 Set Labs Inc.

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
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";

import { IBasicIssuanceModule } from "../interfaces/IBasicIssuanceModule.sol";
import { ISetToken } from "../interfaces/ISetToken.sol";
import { PreciseUnitMath } from "../lib/PreciseUnitMath.sol";

contract APYRescue is Ownable {

    using SafeMath for uint256;
    using PreciseUnitMath for uint256;

    ISetToken public immutable apyToken;
    IBasicIssuanceModule public immutable basicIssuanceModule;

    mapping(address => uint256) public shares;
    uint256 public totalShares;

    IERC20[] public recoveredTokens;
    uint256[] public recoveredTokenAmounts;
    
    bool public recoveryExecuted;

    /* ============ Constructor ============ */

    constructor(
        ISetToken _apyToken,
        IERC20[] memory _recoveredTokens,
        IBasicIssuanceModule _basicIssuanceModule
    )
        public
        Ownable()
    {
        apyToken = _apyToken;
        recoveredTokens = _recoveredTokens;
        basicIssuanceModule = _basicIssuanceModule;
    }

    /* ============ External Functions ============ */
    
    /**
     * Deposits APY tokens into the contract and mints shares to caller. Caller must approve
     * APY tokens to contract before calling.
     */
    function deposit(uint256 _amount) external {
        require(!recoveryExecuted, "APYRescue: redemption already initiated");

        // Must approve _amount to this contract to be transferred
        apyToken.transferFrom(msg.sender, address(this), _amount);

        shares[msg.sender] = shares[msg.sender].add(_amount);
        totalShares = totalShares.add(_amount);
    }

    /**
     * ONLY OWNER: Redeems APY tokens from the BasicIssuanceModule and stores amount of recovered tokens.
     */
    function recoverAssets() external onlyOwner {
        require(!recoveryExecuted, "APYRescue: redemption already initiated");
        uint256 apyTokenBalance = apyToken.balanceOf(address(this));
        basicIssuanceModule.redeem(apyToken, apyTokenBalance, address(this));

        recoveryExecuted = true;

        for (uint256 i = 0; i < recoveredTokens.length; i++) {
            recoveredTokenAmounts.push(recoveredTokens[i].balanceOf(address(this)));
        }
    }

    /**
     * Withdraws recovered tokens to caller based on their share of the recovered tokens.
     */
    function withdrawRecoveredFunds() external {
        require(recoveryExecuted, "APYRescue: redemption not initiated");
        uint256 callerShares = shares[msg.sender];

        shares[msg.sender] = 0;

        for (uint256 i = 0; i < recoveredTokens.length; i++) {
            IERC20 recoveredToken = recoveredTokens[i];
            uint256 shareOfRecoveredTokens = callerShares
                .mul(recoveredTokenAmounts[i])
                .div(totalShares);
            recoveredToken.transfer(msg.sender, shareOfRecoveredTokens);
        }
    }

    /**
     * Use in case of failure in recovery, allows users to clawback tokens deposited in contract. Cannot be called if
     * recovery has been executed.
     */
    function clawbackDepositedSets() external {
        require(!recoveryExecuted, "APYRescue: redemption already initiated");

        uint256 depositedShares = shares[msg.sender];
        
        shares[msg.sender] = 0;
        totalShares = totalShares.sub(depositedShares);

        apyToken.transfer(msg.sender, depositedShares);
    }

    /* ============ View Functions ============ */
    function getRecoveredTokens() external view returns(IERC20[] memory) {
        return recoveredTokens;
    }

    function getRecoveredTokenAmounts() external view returns(uint256[] memory) {
        return recoveredTokenAmounts;
    }
}
