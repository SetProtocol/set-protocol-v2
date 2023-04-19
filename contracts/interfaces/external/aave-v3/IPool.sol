pragma solidity 0.6.10;
pragma experimental ABIEncoderV2;
import { DataTypes } from "./Datatypes.sol";

interface IPool {
    event BackUnbacked(address indexed reserve, address indexed backer, uint256 amount, uint256 fee);
    event Borrow(
        address indexed reserve,
        address user,
        address indexed onBehalfOf,
        uint256 amount,
        uint8 interestRateMode,
        uint256 borrowRate,
        uint16 indexed referralCode
    );
    event FlashLoan(
        address indexed target,
        address initiator,
        address indexed asset,
        uint256 amount,
        uint8 interestRateMode,
        uint256 premium,
        uint16 indexed referralCode
    );
    event IsolationModeTotalDebtUpdated(address indexed asset, uint256 totalDebt);
    event LiquidationCall(
        address indexed collateralAsset,
        address indexed debtAsset,
        address indexed user,
        uint256 debtToCover,
        uint256 liquidatedCollateralAmount,
        address liquidator,
        bool receiveAToken
    );
    event MintUnbacked(
        address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode
    );
    event MintedToTreasury(address indexed reserve, uint256 amountMinted);
    event RebalanceStableBorrowRate(address indexed reserve, address indexed user);
    event Repay(
        address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens
    );
    event ReserveDataUpdated(
        address indexed reserve,
        uint256 liquidityRate,
        uint256 stableBorrowRate,
        uint256 variableBorrowRate,
        uint256 liquidityIndex,
        uint256 variableBorrowIndex
    );
    event ReserveUsedAsCollateralDisabled(address indexed reserve, address indexed user);
    event ReserveUsedAsCollateralEnabled(address indexed reserve, address indexed user);
    event Supply(
        address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode
    );
    event SwapBorrowRateMode(address indexed reserve, address indexed user, uint8 interestRateMode);
    event UserEModeSet(address indexed user, uint8 categoryId);
    event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount);

    struct EModeCategory {
        uint16 ltv;
        uint16 liquidationThreshold;
        uint16 liquidationBonus;
        address priceSource;
        string label;
    }

    struct ReserveConfigurationMap {
        uint256 data;
    }

    struct ReserveData {
        ReserveConfigurationMap configuration;
        uint128 liquidityIndex;
        uint128 currentLiquidityRate;
        uint128 variableBorrowIndex;
        uint128 currentVariableBorrowRate;
        uint128 currentStableBorrowRate;
        uint40 lastUpdateTimestamp;
        uint16 id;
        address aTokenAddress;
        address stableDebtTokenAddress;
        address variableDebtTokenAddress;
        address interestRateStrategyAddress;
        uint128 accruedToTreasury;
        uint128 unbacked;
        uint128 isolationModeTotalDebt;
    }

    struct UserConfigurationMap {
        uint256 data;
    }

    function ADDRESSES_PROVIDER() external view returns (address);
    function BRIDGE_PROTOCOL_FEE() external view returns (uint256);
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
    function FLASHLOAN_PREMIUM_TO_PROTOCOL() external view returns (uint128);
    function MAX_NUMBER_RESERVES() external view returns (uint16);
    function MAX_STABLE_RATE_BORROW_SIZE_PERCENT() external view returns (uint256);
    function POOL_REVISION() external view returns (uint256);
    function backUnbacked(address asset, uint256 amount, uint256 fee) external returns (uint256);
    function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)
        external;
    function configureEModeCategory(uint8 id, DataTypes.EModeCategory memory category) external;
    function deposit(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function dropReserve(address asset) external;
    function finalizeTransfer(
        address asset,
        address from,
        address to,
        uint256 amount,
        uint256 balanceFromBefore,
        uint256 balanceToBefore
    ) external;
    function flashLoan(
        address receiverAddress,
        address[] memory assets,
        uint256[] memory amounts,
        uint256[] memory interestRateModes,
        address onBehalfOf,
        bytes memory params,
        uint16 referralCode
    ) external;
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes memory params,
        uint16 referralCode
    ) external;
    function getConfiguration(address asset) external view returns (DataTypes.ReserveConfigurationMap memory);
    function getEModeCategoryData(uint8 id) external view returns (DataTypes.EModeCategory memory);
    function getReserveAddressById(uint16 id) external view returns (address);
    function getReserveData(address asset) external view returns (DataTypes.ReserveData memory);
    function getReserveNormalizedIncome(address asset) external view returns (uint256);
    function getReserveNormalizedVariableDebt(address asset) external view returns (uint256);
    function getReservesList() external view returns (address[] memory);
    function getUserAccountData(address user)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );
    function getUserConfiguration(address user) external view returns (DataTypes.UserConfigurationMap memory);
    function getUserEMode(address user) external view returns (uint256);
    function initReserve(
        address asset,
        address aTokenAddress,
        address stableDebtAddress,
        address variableDebtAddress,
        address interestRateStrategyAddress
    ) external;
    function initialize(address provider) external;
    function liquidationCall(
        address collateralAsset,
        address debtAsset,
        address user,
        uint256 debtToCover,
        bool receiveAToken
    ) external;
    function mintToTreasury(address[] memory assets) external;
    function mintUnbacked(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function rebalanceStableBorrowRate(address asset, address user) external;
    function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf)
        external
        returns (uint256);
    function repayWithATokens(address asset, uint256 amount, uint256 interestRateMode) external returns (uint256);
    function repayWithPermit(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        address onBehalfOf,
        uint256 deadline,
        uint8 permitV,
        bytes32 permitR,
        bytes32 permitS
    ) external returns (uint256);
    function rescueTokens(address token, address to, uint256 amount) external;
    function resetIsolationModeTotalDebt(address asset) external;
    function setConfiguration(address asset, DataTypes.ReserveConfigurationMap memory configuration) external;
    function setReserveInterestRateStrategyAddress(address asset, address rateStrategyAddress) external;
    function setUserEMode(uint8 categoryId) external;
    function setUserUseReserveAsCollateral(address asset, bool useAsCollateral) external;
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function supplyWithPermit(
        address asset,
        uint256 amount,
        address onBehalfOf,
        uint16 referralCode,
        uint256 deadline,
        uint8 permitV,
        bytes32 permitR,
        bytes32 permitS
    ) external;
    function swapBorrowRateMode(address asset, uint256 interestRateMode) external;
    function updateBridgeProtocolFee(uint256 protocolFee) external;
    function updateFlashloanPremiums(uint128 flashLoanPremiumTotal, uint128 flashLoanPremiumToProtocol) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

