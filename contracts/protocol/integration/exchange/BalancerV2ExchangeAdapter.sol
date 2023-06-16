/*
    Copyright 2023 IndexCoop.
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

import {IVault} from "../../../interfaces/external/balancer-v2/IVault.sol";
import {IExchangeAdapter} from "../../../interfaces/IExchangeAdapter.sol";

/**
 * @title BalancerV2ExchangeAdapter
 * @author FlattestWhite
 *
 * This contract is intended to be used by TradeModule and LeverageModule.
 */
contract BalancerV2ExchangeAdapter is IExchangeAdapter {
  /* ============ State Variables ============ */

  // Address of Balancer V2 vault contract
  address public immutable vault;

  /* ============ Constructor ============ */

  /**
   * Set state variables
   *
   * @param _vault        balancer vault address
   */
  constructor(address _vault) public {
    vault = _vault;
  }

  /**
   * Returns the address to approve source tokens to for trading. This is the Balancer V2 Vault address
   *
   * @return address             Address of the contract to approve tokens to
   */
  function getSpender() external view override returns (address) {
    return vault;
  }

  /**
   * Return calldata for BalancerV2 Vault.
   *
   * @param _fromToken                 Address of the token to be sold
   * @param _toToken                   Address of the token to buy
   * @param _toAddress                 Address to send the toToken to
   * @param _fromQuantity              Fixed amount of fromToken to sell
   * @param _minToQuantity             Min amount of toTokens tokens to receive
   * @param _data                      Encoded poolId
   *
   * @return address                   Target contract address
   * @return uint256                   Call value
   * @return bytes                     Trade calldata
   */
  function getTradeCalldata(
    address _fromToken,
    address _toToken,
    address _toAddress,
    uint256 _fromQuantity,
    uint256 _minToQuantity,
    bytes memory _data
  ) external view override returns (address, uint256, bytes memory) {
    bytes32 poolId = abi.decode(_data, (bytes32));

    IVault.SingleSwap memory swap = IVault.SingleSwap({
      poolId: poolId,
      kind: IVault.SwapKind.GIVEN_IN,
      assetIn: _fromToken,
      assetOut: _toToken,
      amount: _fromQuantity,
      userData: ""
    });

    IVault.FundManagement memory fm = IVault.FundManagement({
      sender: _toAddress,
      fromInternalBalance: false,
      recipient: payable(_toAddress),
      toInternalBalance: false
    });

    bytes memory callData = abi.encodeWithSelector(
      IVault.swap.selector,
      swap,
      fm,
      _minToQuantity,
      uint256(-1)
    );
    return (vault, 0, callData);
  }
}
