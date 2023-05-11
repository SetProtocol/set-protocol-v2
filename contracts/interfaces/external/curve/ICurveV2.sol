// SPDX-License-Identifier: Apache License, Version 2.0
pragma solidity 0.6.10;

import "./ICurveMinter.sol";

interface ICurveV2 is ICurveMinter {
  function remove_liquidity_one_coin(
    uint256 burn_amount,
    uint256 i,
    uint256 mim_received
  ) external;

  function calc_withdraw_one_coin(uint256, uint256)
    external
    view
    returns (uint256);

  function exchange(
    uint256 i,
    uint256 j,
    uint256 dx,
    uint256 min_dy
  ) external returns (uint256);
}
