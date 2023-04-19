pragma solidity 0.6.10;
pragma experimental ABIEncoderV2;

interface IAaveProtocolDataProvider {
    struct TokenData {
        string symbol;
        address tokenAddress;
    }

    function ADDRESSES_PROVIDER() external view returns (address);
    function getATokenTotalSupply(address asset) external view returns (uint256);
    function getAllATokens() external view returns (TokenData[] memory);
    function getAllReservesTokens() external view returns (TokenData[] memory);
    function getDebtCeiling(address asset) external view returns (uint256);
    function getDebtCeilingDecimals() external pure returns (uint256);
    function getFlashLoanEnabled(address asset) external view returns (bool);
    function getInterestRateStrategyAddress(address asset) external view returns (address irStrategyAddress);
    function getLiquidationProtocolFee(address asset) external view returns (uint256);
    function getPaused(address asset) external view returns (bool isPaused);
    function getReserveCaps(address asset) external view returns (uint256 borrowCap, uint256 supplyCap);
    function getReserveConfigurationData(address asset)
        external
        view
        returns (
            uint256 decimals,
            uint256 ltv,
            uint256 liquidationThreshold,
            uint256 liquidationBonus,
            uint256 reserveFactor,
            bool usageAsCollateralEnabled,
            bool borrowingEnabled,
            bool stableBorrowRateEnabled,
            bool isActive,
            bool isFrozen
        );
    function getReserveData(address asset)
        external
        view
        returns (
            uint256 unbacked,
            uint256 accruedToTreasuryScaled,
            uint256 totalAToken,
            uint256 totalStableDebt,
            uint256 totalVariableDebt,
            uint256 liquidityRate,
            uint256 variableBorrowRate,
            uint256 stableBorrowRate,
            uint256 averageStableBorrowRate,
            uint256 liquidityIndex,
            uint256 variableBorrowIndex,
            uint40 lastUpdateTimestamp
        );
    function getReserveEModeCategory(address asset) external view returns (uint256);
    function getReserveTokensAddresses(address asset)
        external
        view
        returns (address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress);
    function getSiloedBorrowing(address asset) external view returns (bool);
    function getTotalDebt(address asset) external view returns (uint256);
    function getUnbackedMintCap(address asset) external view returns (uint256);
    function getUserReserveData(address asset, address user)
        external
        view
        returns (
            uint256 currentATokenBalance,
            uint256 currentStableDebt,
            uint256 currentVariableDebt,
            uint256 principalStableDebt,
            uint256 scaledVariableDebt,
            uint256 stableBorrowRate,
            uint256 liquidityRate,
            uint40 stableRateLastUpdated,
            bool usageAsCollateralEnabled
        );
}

