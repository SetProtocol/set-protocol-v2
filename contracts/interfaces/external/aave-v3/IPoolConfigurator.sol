pragma solidity 0.6.10;
pragma experimental ABIEncoderV2;
import {ConfiguratorInputTypes} from "./ConfigurationInputTypes.sol";

interface IPoolConfigurator {
    event ATokenUpgraded(address indexed asset, address indexed proxy, address indexed implementation);
    event BorrowCapChanged(address indexed asset, uint256 oldBorrowCap, uint256 newBorrowCap);
    event BorrowableInIsolationChanged(address asset, bool borrowable);
    event BridgeProtocolFeeUpdated(uint256 oldBridgeProtocolFee, uint256 newBridgeProtocolFee);
    event CollateralConfigurationChanged(
        address indexed asset, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus
    );
    event DebtCeilingChanged(address indexed asset, uint256 oldDebtCeiling, uint256 newDebtCeiling);
    event EModeAssetCategoryChanged(address indexed asset, uint8 oldCategoryId, uint8 newCategoryId);
    event EModeCategoryAdded(
        uint8 indexed categoryId,
        uint256 ltv,
        uint256 liquidationThreshold,
        uint256 liquidationBonus,
        address oracle,
        string label
    );
    event FlashloanPremiumToProtocolUpdated(
        uint128 oldFlashloanPremiumToProtocol, uint128 newFlashloanPremiumToProtocol
    );
    event FlashloanPremiumTotalUpdated(uint128 oldFlashloanPremiumTotal, uint128 newFlashloanPremiumTotal);
    event LiquidationProtocolFeeChanged(address indexed asset, uint256 oldFee, uint256 newFee);
    event ReserveActive(address indexed asset, bool active);
    event ReserveBorrowing(address indexed asset, bool enabled);
    event ReserveDropped(address indexed asset);
    event ReserveFactorChanged(address indexed asset, uint256 oldReserveFactor, uint256 newReserveFactor);
    event ReserveFlashLoaning(address indexed asset, bool enabled);
    event ReserveFrozen(address indexed asset, bool frozen);
    event ReserveInitialized(
        address indexed asset,
        address indexed aToken,
        address stableDebtToken,
        address variableDebtToken,
        address interestRateStrategyAddress
    );
    event ReserveInterestRateStrategyChanged(address indexed asset, address oldStrategy, address newStrategy);
    event ReservePaused(address indexed asset, bool paused);
    event ReserveStableRateBorrowing(address indexed asset, bool enabled);
    event SiloedBorrowingChanged(address indexed asset, bool oldState, bool newState);
    event StableDebtTokenUpgraded(address indexed asset, address indexed proxy, address indexed implementation);
    event SupplyCapChanged(address indexed asset, uint256 oldSupplyCap, uint256 newSupplyCap);
    event UnbackedMintCapChanged(address indexed asset, uint256 oldUnbackedMintCap, uint256 newUnbackedMintCap);
    event VariableDebtTokenUpgraded(address indexed asset, address indexed proxy, address indexed implementation);

    struct InitReserveInput {
        address aTokenImpl;
        address stableDebtTokenImpl;
        address variableDebtTokenImpl;
        uint8 underlyingAssetDecimals;
        address interestRateStrategyAddress;
        address underlyingAsset;
        address treasury;
        address incentivesController;
        string aTokenName;
        string aTokenSymbol;
        string variableDebtTokenName;
        string variableDebtTokenSymbol;
        string stableDebtTokenName;
        string stableDebtTokenSymbol;
        bytes params;
    }

    struct UpdateATokenInput {
        address asset;
        address treasury;
        address incentivesController;
        string name;
        string symbol;
        address implementation;
        bytes params;
    }

    struct UpdateDebtTokenInput {
        address asset;
        address incentivesController;
        string name;
        string symbol;
        address implementation;
        bytes params;
    }

    function CONFIGURATOR_REVISION() external view returns (uint256);
    function configureReserveAsCollateral(
        address asset,
        uint256 ltv,
        uint256 liquidationThreshold,
        uint256 liquidationBonus
    ) external;
    function dropReserve(address asset) external;
    function initReserves(ConfiguratorInputTypes.InitReserveInput[] memory input) external;
    function initialize(address provider) external;
    function setAssetEModeCategory(address asset, uint8 newCategoryId) external;
    function setBorrowCap(address asset, uint256 newBorrowCap) external;
    function setBorrowableInIsolation(address asset, bool borrowable) external;
    function setDebtCeiling(address asset, uint256 newDebtCeiling) external;
    function setEModeCategory(
        uint8 categoryId,
        uint16 ltv,
        uint16 liquidationThreshold,
        uint16 liquidationBonus,
        address oracle,
        string memory label
    ) external;
    function setLiquidationProtocolFee(address asset, uint256 newFee) external;
    function setPoolPause(bool paused) external;
    function setReserveActive(address asset, bool active) external;
    function setReserveBorrowing(address asset, bool enabled) external;
    function setReserveFactor(address asset, uint256 newReserveFactor) external;
    function setReserveFlashLoaning(address asset, bool enabled) external;
    function setReserveFreeze(address asset, bool freeze) external;
    function setReserveInterestRateStrategyAddress(address asset, address newRateStrategyAddress) external;
    function setReservePause(address asset, bool paused) external;
    function setReserveStableRateBorrowing(address asset, bool enabled) external;
    function setSiloedBorrowing(address asset, bool newSiloed) external;
    function setSupplyCap(address asset, uint256 newSupplyCap) external;
    function setUnbackedMintCap(address asset, uint256 newUnbackedMintCap) external;
    function updateAToken(ConfiguratorInputTypes.UpdateATokenInput memory input) external;
    function updateBridgeProtocolFee(uint256 newBridgeProtocolFee) external;
    function updateFlashloanPremiumToProtocol(uint128 newFlashloanPremiumToProtocol) external;
    function updateFlashloanPremiumTotal(uint128 newFlashloanPremiumTotal) external;
    function updateStableDebtToken(ConfiguratorInputTypes.UpdateDebtTokenInput memory input) external;
    function updateVariableDebtToken(ConfiguratorInputTypes.UpdateDebtTokenInput memory input) external;
}

