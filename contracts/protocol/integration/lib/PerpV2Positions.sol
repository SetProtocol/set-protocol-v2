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

import "@openzeppelin/contracts/math/SignedSafeMath.sol";
import { IAccountBalance } from "../../../interfaces/external/perp-v2/IAccountBalance.sol";
import { ISetToken } from "../../../interfaces/ISetToken.sol";
import { PreciseUnitMath } from "../../../lib/PreciseUnitMath.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";
import { UnitConversionUtils } from "../../../lib/UnitConversionUtils.sol";

library PerpV2Positions {
    using SignedSafeMath for int256;
    using SafeCast for uint256;
    using PreciseUnitMath for int256;
    
    struct PositionNotionalInfo {
        address baseToken;              // Virtual token minted by the Perp protocol
        int256 baseBalance;             // Base position notional quantity in 10**18 decimals. When negative, position is short
        int256 quoteBalance;            // vUSDC "debt" notional quantity minted to open position. When positive, position is short
    }

    struct PositionUnitInfo {
        address baseToken;              // Virtual token minted by the Perp protocol
        int256 baseUnit;                // Base position unit. When negative, position is short
        int256 quoteUnit;               // vUSDC "debt" position unit. When positive, position is short
    }

    /**
     * @dev Retrieves net quote balance of all open positions.
     *
     * @param _setToken             Instance of SetToken
     * @return netQuoteBalance      Net quote balance of all open positions
     */
    function getNetQuoteBalance(
        ISetToken _setToken, 
        address[] storage baseTokens, 
        IAccountBalance perpAccountBalance
    ) 
        external 
        view 
        returns (int256 netQuoteBalance) 
    {
        uint256 numBaseTokens = baseTokens.length;
        for (uint256 i = 0; i < numBaseTokens; i++) {
            netQuoteBalance = netQuoteBalance.add(
                perpAccountBalance.getQuote(address(_setToken), baseTokens[i])
            );
        }
    }

    /**
     * @dev Returns a PositionUnitNotionalInfo array representing all positions open for the SetToken.
     *
     * @param _setToken         Instance of SetToken
     *
     * @return PositionUnitInfo array, in which each element has properties:
     *
     *         + baseToken: address,
     *         + baseBalance:  baseToken balance as notional quantity (10**18)
     *         + quoteBalance: USDC quote asset balance as notional quantity (10**18)
     */
    function getPositionNotionalInfo(
        ISetToken _setToken, 
        address[] storage baseTokens, 
        IAccountBalance perpAccountBalance
    ) 
        public 
        view 
        returns (PositionNotionalInfo[] memory) 
    {
        uint256 numBaseTokens = baseTokens.length;
        PositionNotionalInfo[] memory positionInfo = new PositionNotionalInfo[](numBaseTokens);

        for(uint i = 0; i < numBaseTokens; i++){
            address baseToken = baseTokens[i];
            positionInfo[i] = PositionNotionalInfo({
                baseToken: baseToken,
                baseBalance: perpAccountBalance.getBase(
                    address(_setToken),
                    baseToken
                ),
                quoteBalance: perpAccountBalance.getQuote(
                    address(_setToken),
                    baseToken
                )
            });
        }

        return positionInfo;
    }
    
    /**
     * @dev Returns a PerpV2Positions.PositionUnitInfo array representing all positions open for the SetToken.
     *
     * @param _setToken         Instance of SetToken
     *
     * @return PerpV2Positions.PositionUnitInfo array, in which each element has properties:
     *
     *         + baseToken: address,
     *         + baseUnit:  baseToken balance as position unit (10**18)
     *         + quoteUnit: USDC quote asset balance as position unit (10**18)
     */
    function getPositionUnitInfo(
        ISetToken _setToken, 
        address[] storage baseTokens, 
        IAccountBalance perpAccountBalance
    ) 
        external 
        view 
        returns (PositionUnitInfo[] memory) 
    {
        int256 totalSupply = _setToken.totalSupply().toInt256();
        PositionNotionalInfo[] memory positionNotionalInfo = getPositionNotionalInfo(
            _setToken,
            baseTokens,
            perpAccountBalance
        );
        
        uint256 positionLength = positionNotionalInfo.length;
        PositionUnitInfo[] memory positionUnitInfo = new PositionUnitInfo[](positionLength);

        for(uint i = 0; i < positionLength; i++){
            PositionNotionalInfo memory currentPosition = positionNotionalInfo[i];
            positionUnitInfo[i] = PositionUnitInfo({
                baseToken: currentPosition.baseToken,
                baseUnit: currentPosition.baseBalance.preciseDiv(totalSupply),
                quoteUnit: currentPosition.quoteBalance.preciseDiv(totalSupply)
            });
        }

        return positionUnitInfo;
    }
}