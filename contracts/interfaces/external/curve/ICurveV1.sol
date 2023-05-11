// SPDX-License-Identifier: Apache License, Version 2.0
pragma solidity 0.6.10;

import "./ICurveMinter.sol";

interface ICurveV1 is ICurveMinter {
  function remove_liquidity_one_coin(
    uint256 burn_amount,
    int128 i,
    uint256 mim_received
  ) external;

  function calc_withdraw_one_coin(uint256, int128)
    external
    view
    returns (uint256);

  function exchange(
    int128 i,
    int128 j,
    uint256 dx,
    uint256 min_dy
  ) external returns (uint256);
}
