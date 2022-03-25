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

import { IWETH } from "../../../interfaces/external/IWETH.sol";
import { ICurveStEthExchange } from "../../../interfaces/external/ICurveStEthExchange.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title CurveStEthExchangeAdapter
 * @author Set Protocol
 *
 * Exchange adapter for the specialized Curve stETH <-> ETH
 * exchange contracts. Implements helper functionality for
 * wrapping and unwrapping WETH since the curve exchange uses
 * raw ETH.
 */
contract CurveStEthExchangeAdapter {

    /* ========= State Variables ========= */

    IWETH immutable public weth;
    IERC20 immutable public stETH;
    ICurveStEthExchange immutable public exchange;

    /* ========= Constructor ========== */

    constructor(
        IWETH _weth,
        IERC20 _stETH,
        ICurveStEthExchange _exchange
    )
        public
    {
        weth = _weth;
        stETH = _stETH;
        exchange = _exchange;

        _stETH.approve(address(_exchange), uint256(-1));
    }

    /* ======== External Functions ======== */

    function getTradeCalldata(
        address _sourceToken,
        address _destinationToken,
        address _destinationAddress,
        uint256 _sourceQuantity,
        uint256 _minDestinationQuantity,
        bytes memory /* data */
    )
        external
        view
        returns (bytes memory)
    {
        if (_sourceToken == address(weth) && _destinationToken == address(stETH)) {
            return abi.encodeWithSignature(
                "buyStEth(uint256,uint256,address)",
                _sourceQuantity,
                _minDestinationQuantity,
                _destinationAddress
            );
        } else if (_sourceToken == address(stETH) && _destinationToken == address(weth)) {
            return abi.encodeWithSignature(
                "sellStEth(uint256,uint256,address)",
                _sourceQuantity,
                _minDestinationQuantity,
                _destinationAddress
            );
        } else {
            revert("Must swap between weth and stETH");
        }
    }

    function getSpender() external view returns (address) {
        return address(this);
    }

    function buyStEth(
        uint256 _sourceQuantity,
        uint256 _minDestinationQuantity,
        address _destinationAddress
    )
        external
    {
        // transfer weth
        weth.transferFrom(msg.sender, address(this), _sourceQuantity);

        // unwrap weth
        weth.withdraw(_sourceQuantity);

        // buy stETH
        uint256 amountOut = exchange.exchange{value: _sourceQuantity} (
            0,
            1,
            _sourceQuantity,
            _minDestinationQuantity
        );

        // transfer proceeds
        stETH.transfer(_destinationAddress, amountOut);
    }

    function sellStEth(
        uint256 _sourceQuantity,
        uint256 _minDestinationQuantity,
        address _destinationAddress
    )
        external
    {
        // transfer stETH
        stETH.transferFrom(msg.sender, address(this), _sourceQuantity);

        // sell stETH
        uint256 amountOut = exchange.exchange(1, 0, _sourceQuantity, _minDestinationQuantity);

        // wrap eth
        weth.deposit{value: amountOut}();

        // transfer proceeds
        weth.transfer(_destinationAddress, amountOut);
    }

    receive() external payable {}
}
