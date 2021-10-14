pragma solidity 0.6.10;

interface IMetaPoolZap {
    function add_liquidity(
        uint256[2] calldata _depositAmounts,
        uint256 _minMintAmount
    ) external returns (uint256);

    function remove_liquidity(
        address _pool,
        uint256 _burnAmount,
        uint256[2] calldata _minAmounts
    ) external;

    function remove_liquidity_one_coin(
        uint256 _burnAmount,
        int128 _i,
        uint256 _minAmount
    ) external;
}