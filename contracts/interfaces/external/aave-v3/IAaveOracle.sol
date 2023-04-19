pragma solidity ^0.8.10;

interface IAaveOracle {
    event AssetSourceUpdated(address indexed asset, address indexed source);
    event BaseCurrencySet(address indexed baseCurrency, uint256 baseCurrencyUnit);
    event FallbackOracleUpdated(address indexed fallbackOracle);

    function ADDRESSES_PROVIDER() external view returns (address);
    function BASE_CURRENCY() external view returns (address);
    function BASE_CURRENCY_UNIT() external view returns (uint256);
    function getAssetPrice(address asset) external view returns (uint256);
    function getAssetsPrices(address[] memory assets) external view returns (uint256[] memory);
    function getFallbackOracle() external view returns (address);
    function getSourceOfAsset(address asset) external view returns (address);
    function setAssetSources(address[] memory assets, address[] memory sources) external;
    function setFallbackOracle(address fallbackOracle) external;
}

