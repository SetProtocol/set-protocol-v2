// SPDX-License-Identifier: Apache License, Version 2.0
pragma solidity 0.6.10;

interface ICurveMinter {
  function coins(uint256) external view returns (address);

  function balances(uint256) external view returns (uint256);

  function add_liquidity(uint256[2] calldata amounts, uint256 min_mint_amount)
    external;

  function add_liquidity(uint256[3] calldata amounts, uint256 min_mint_amount)
    external;

  function add_liquidity(uint256[4] calldata amounts, uint256 min_mint_amount)
    external;

  function remove_liquidity(uint256 amount, uint256[2] calldata min_amounts)
    external;

  function remove_liquidity(uint256 amount, uint256[3] calldata min_amounts)
    external;

  function remove_liquidity(uint256 amount, uint256[4] calldata min_amounts)
    external;
}