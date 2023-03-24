pragma solidity 0.6.10;

interface IPoolAddressesProvider {
    event ACLAdminUpdated(address indexed oldAddress, address indexed newAddress);
    event ACLManagerUpdated(address indexed oldAddress, address indexed newAddress);
    event AddressSet(bytes32 indexed id, address indexed oldAddress, address indexed newAddress);
    event AddressSetAsProxy(
        bytes32 indexed id,
        address indexed proxyAddress,
        address oldImplementationAddress,
        address indexed newImplementationAddress
    );
    event MarketIdSet(string indexed oldMarketId, string indexed newMarketId);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event PoolConfiguratorUpdated(address indexed oldAddress, address indexed newAddress);
    event PoolDataProviderUpdated(address indexed oldAddress, address indexed newAddress);
    event PoolUpdated(address indexed oldAddress, address indexed newAddress);
    event PriceOracleSentinelUpdated(address indexed oldAddress, address indexed newAddress);
    event PriceOracleUpdated(address indexed oldAddress, address indexed newAddress);
    event ProxyCreated(bytes32 indexed id, address indexed proxyAddress, address indexed implementationAddress);

    function getACLAdmin() external view returns (address);
    function getACLManager() external view returns (address);
    function getAddress(bytes32 id) external view returns (address);
    function getMarketId() external view returns (string memory);
    function getPool() external view returns (address);
    function getPoolConfigurator() external view returns (address);
    function getPoolDataProvider() external view returns (address);
    function getPriceOracle() external view returns (address);
    function getPriceOracleSentinel() external view returns (address);
    function owner() external view returns (address);
    function renounceOwnership() external;
    function setACLAdmin(address newAclAdmin) external;
    function setACLManager(address newAclManager) external;
    function setAddress(bytes32 id, address newAddress) external;
    function setAddressAsProxy(bytes32 id, address newImplementationAddress) external;
    function setMarketId(string memory newMarketId) external;
    function setPoolConfiguratorImpl(address newPoolConfiguratorImpl) external;
    function setPoolDataProvider(address newDataProvider) external;
    function setPoolImpl(address newPoolImpl) external;
    function setPriceOracle(address newPriceOracle) external;
    function setPriceOracleSentinel(address newPriceOracleSentinel) external;
    function transferOwnership(address newOwner) external;
}

