// SPDX-License-Identifier: MIT
pragma solidity 0.8.11;

interface IVelodromeRouter {
    function pairFor(address tokenA, address tokenB, bool stable) external view returns (address pair);
}
