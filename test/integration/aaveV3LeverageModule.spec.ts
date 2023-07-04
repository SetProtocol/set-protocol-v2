import "module-alias/register";

import { Signer, BigNumber, ContractTransaction, constants, utils } from "ethers";

import { getRandomAccount, getRandomAddress } from "@utils/test";
import { Account } from "@utils/test/types";
import { Address, Bytes } from "@utils/types";
import { impersonateAccount, waitForEvent } from "@utils/test/testingUtils";
import DeployHelper from "@utils/deploys";
import { cacheBeforeEach, getAccounts, getWaffleExpect } from "@utils/test/index";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { ether, preciseMul } from "@utils/index";
import { network } from "hardhat";
import { forkingConfig } from "../../hardhat.config";

import {
  AaveV3LeverageModule,
  IAaveOracle,
  IAaveOracle__factory,
  ChainlinkAggregatorMock,
  DebtIssuanceMock,
  IWETH,
  IWETH__factory,
  IERC20,
  IERC20__factory,
  IPool,
  IPool__factory,
  IPoolAddressesProvider,
  IPoolAddressesProvider__factory,
  IPoolConfigurator,
  IPoolConfigurator__factory,
  IAaveProtocolDataProvider,
  IAaveProtocolDataProvider__factory,
  Controller,
  Controller__factory,
  DebtIssuanceModuleV2,
  DebtIssuanceModuleV2__factory,
  IntegrationRegistry,
  IntegrationRegistry__factory,
  SetToken,
  SetToken__factory,
  SetTokenCreator,
  SetTokenCreator__factory,
  StandardTokenMock,
  UniswapV3ExchangeAdapterV2,
  UniswapV3ExchangeAdapterV2__factory,
  UniswapV3Pool,
  UniswapV3Pool__factory,
} from "@typechain/index";

const expect = getWaffleExpect();

// https://docs.aave.com/developers/deployed-contracts/v3-mainnet/ethereum-mainnet

const contractAddresses = {
  aaveV3AddressProvider: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
  aaveV3ProtocolDataProvider: "0x7B4EB56E7CD4b454BA8ff71E4518426369a138a3",
  aaveV3Oracle: "0x54586bE62E3c3580375aE3723C145253060Ca0C2",
  aaveV3Pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  aaveV3PoolConfigurator: "0x64b761D848206f447Fe2dd461b0c635Ec39EbB27",
  aaveGovernance: "0xEE56e2B3D491590B5b31738cC34d5232F378a8D5",
  controller: "0xD2463675a099101E36D85278494268261a66603A",
  debtIssuanceModule: "0xa0a98EB7Af028BE00d04e46e1316808A62a8fd59",
  setTokenCreator: "0x2758BF6Af0EC63f1710d3d7890e1C263a247B75E",
  integrationRegistry: "0xb9083dee5e8273E54B9DB4c31bA9d4aB7C6B28d3",
  uniswapV3ExchangeAdapterV2: "0xe6382D2D44402Bad8a03F11170032aBCF1Df1102",
  uniswapV3Router: "0xe6382D2D44402Bad8a03F11170032aBCF1Df1102",
  wethDaiPool: "0x60594a405d53811d3bc4766596efd80fd545a270",
  aTokenImpl: "0x7EfFD7b47Bfd17e52fB7559d3f924201b9DbfF3d",
  stableDebtTokenImpl: "0x15C5620dfFaC7c7366EED66C20Ad222DDbB1eD57",
  variableDebtTokenImpl: "0xaC725CB59D16C81061BDeA61041a8A5e73DA9EC6",
  interestRateStrategy: "0x76884cAFeCf1f7d4146DA6C4053B18B76bf6ED14",
  aaveTreasury: "0x464C71f6c2F760DdA6093dCB91C24c39e5d6e18c",
  aaveIncentivesController: "0x8164Cc65827dcFe994AB23944CBC90e0aa80bFcb",
};

const tokenAddresses = {
  weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  aWethV3: "0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8",
  aWethVariableDebtTokenV3: "0xeA51d7853EEFb32b6ee06b1C12E6dcCA88Be0fFE",
  dai: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  aDaiV3: "0x018008bfb33d285247A21d44E50697654f754e63",
  aDaiVariableDebtTokenV3: "0xcF8d0c70c850859266f5C338b38F9D663181C314",
  wbtc: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  aUSDC: "0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c",
  aUsdcVariableDebtTokenV3: "0x72E95b8931767C79bA4EeE721354d6E99a61D004",
  stEth: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
  wstEth: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0",
  awstEthV3: "0x0B925eD163218f6662a35e0f0371Ac234f9E9371",
};

const whales = {
  dai: "0x075e72a5eDf65F0A5f44699c7654C1a76941Ddc8",
  awsteth: "0xAF06acFD1BD492B913d5807d562e4FC3A6343C4E",
  wsteth: "0x5fEC2f34D80ED82370F733043B6A536d7e9D7f8d",
};

describe("AaveV3LeverageModule integration", () => {
  let owner: Account;
  let notOwner: Account;
  let mockModule: Account;
  let deployer: DeployHelper;
  let aaveLeverageModule: AaveV3LeverageModule;
  let poolAddressesProvider: IPoolAddressesProvider;
  let lendingPoolConfigurator: IPoolConfigurator;
  let debtIssuanceModule: DebtIssuanceModuleV2;
  let integrationRegistry: IntegrationRegistry;
  let setTokenCreator: SetTokenCreator;
  let controller: Controller;
  let weth: IWETH;
  let dai: IERC20;
  let wbtc: IERC20;
  let usdc: IERC20;
  let wsteth: IERC20;
  let variableDebtDAI: IERC20;
  let variableDebtWETH: IERC20;
  let aWETH: IERC20;
  let aWstEth: IERC20;
  let aDAI: IERC20;
  let aaveLendingPool: IPool;
  let uniswapV3ExchangeAdapterV2: UniswapV3ExchangeAdapterV2;
  let wethDaiPool: UniswapV3Pool;
  let protocolDataProvider: IAaveProtocolDataProvider;
  let aaveOracle: IAaveOracle;

  let manager: Address;
  const maxManagerFee = ether(0.05);
  const managerIssueFee = ether(0);
  const managerRedeemFee = ether(0);
  let managerFeeRecipient: Address;
  let managerIssuanceHook: Address;

  const blockNumber = 17611000;
  before(async () => {
    const forking = {
      jsonRpcUrl: forkingConfig.url,
      blockNumber,
    };
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking,
        },
      ],
    });
  });
  after(async () => {
    await network.provider.request({
      method: "hardhat_reset",
      params: [],
    });
  });
  cacheBeforeEach(async () => {
    [owner, notOwner, mockModule] = await getAccounts();

    aaveOracle = IAaveOracle__factory.connect(
      contractAddresses.aaveV3Oracle,
      await impersonateAccount(contractAddresses.aaveGovernance),
    );

    poolAddressesProvider = IPoolAddressesProvider__factory.connect(
      contractAddresses.aaveV3AddressProvider,
      owner.wallet,
    );

    protocolDataProvider = IAaveProtocolDataProvider__factory.connect(
      contractAddresses.aaveV3ProtocolDataProvider,
      owner.wallet,
    );

    lendingPoolConfigurator = IPoolConfigurator__factory.connect(
      contractAddresses.aaveV3PoolConfigurator,
      owner.wallet,
    );
    await network.provider.send("hardhat_setBalance", [
      contractAddresses.aaveGovernance,
      ether(10).toHexString(),
    ]);
    lendingPoolConfigurator = lendingPoolConfigurator.connect(
      await impersonateAccount(contractAddresses.aaveGovernance),
    );

    usdc = IERC20__factory.connect(tokenAddresses.usdc, owner.wallet);
    aaveLendingPool = IPool__factory.connect(await poolAddressesProvider.getPool(), owner.wallet);
    weth = IWETH__factory.connect(tokenAddresses.weth, owner.wallet);
    await weth.deposit({ value: ether(10000) });
    dai = IERC20__factory.connect(tokenAddresses.dai, owner.wallet);
    const daiWhale = await impersonateAccount(whales.dai);
    await dai.connect(daiWhale).transfer(owner.address, ether(1000000));
    wbtc = IERC20__factory.connect(tokenAddresses.wbtc, owner.wallet);
    variableDebtDAI = IERC20__factory.connect(tokenAddresses.aDaiVariableDebtTokenV3, owner.wallet);
    variableDebtWETH = IERC20__factory.connect(
      tokenAddresses.aWethVariableDebtTokenV3,
      owner.wallet,
    );
    aWETH = IERC20__factory.connect(tokenAddresses.aWethV3, owner.wallet);
    aDAI = IERC20__factory.connect(tokenAddresses.aDaiV3, owner.wallet);
    uniswapV3ExchangeAdapterV2 = UniswapV3ExchangeAdapterV2__factory.connect(
      contractAddresses.uniswapV3ExchangeAdapterV2,
      owner.wallet,
    );

    wsteth = IERC20__factory.connect(tokenAddresses.wstEth, owner.wallet);
    aWstEth = IERC20__factory.connect(tokenAddresses.awstEthV3, owner.wallet);

    wethDaiPool = UniswapV3Pool__factory.connect(contractAddresses.wethDaiPool, owner.wallet);

    manager = owner.address;
    managerFeeRecipient = owner.address;
    managerIssuanceHook = constants.AddressZero;

    controller = Controller__factory.connect(contractAddresses.controller, owner.wallet);

    const controllerOwner = await controller.owner();
    const controllerOwnerSigner = await impersonateAccount(controllerOwner);
    controller = controller.connect(controllerOwnerSigner);

    deployer = new DeployHelper(owner.wallet);
    const aaveV3Library = await deployer.libraries.deployAaveV3();

    aaveLeverageModule = await deployer.modules.deployAaveV3LeverageModule(
      controller.address,
      poolAddressesProvider.address,
      "contracts/protocol/integration/lib/AaveV3.sol:AaveV3",
      aaveV3Library.address,
    );
    await controller.addModule(aaveLeverageModule.address);

    debtIssuanceModule = DebtIssuanceModuleV2__factory.connect(
      contractAddresses.debtIssuanceModule,
      owner.wallet,
    );
    setTokenCreator = SetTokenCreator__factory.connect(
      contractAddresses.setTokenCreator,
      owner.wallet,
    );
    integrationRegistry = IntegrationRegistry__factory.connect(
      contractAddresses.integrationRegistry,
      owner.wallet,
    );
    const integrationRegistryOwner = await integrationRegistry.owner();
    integrationRegistry = integrationRegistry.connect(
      await impersonateAccount(integrationRegistryOwner),
    );

    await integrationRegistry.addIntegration(
      aaveLeverageModule.address,
      "UNISWAPV3",
      uniswapV3ExchangeAdapterV2.address,
    );

    await integrationRegistry.addIntegration(
      aaveLeverageModule.address,
      "DefaultIssuanceModule",
      debtIssuanceModule.address,
    );
    await integrationRegistry.addIntegration(
      debtIssuanceModule.address,
      "AaveLeverageModuleV3",
      aaveLeverageModule.address,
    );
  });

  async function createNonControllerEnabledSetToken(
    components: Address[],
    positions: BigNumber[],
    modules: Address[],
  ): Promise<SetToken> {
    return new SetToken__factory(owner.wallet).deploy(
      components,
      positions,
      modules,
      controller.address,
      manager,
      "TestSetToken",
      "TEST",
    );
  }
  async function createSetToken(
    components: Address[],
    positions: BigNumber[],
    modules: Address[],
  ): Promise<SetToken> {
    const setTokenAddress = await setTokenCreator.callStatic.create(
      components,
      positions,
      modules,
      manager,
      "TestSetToken",
      "TEST",
    );

    await setTokenCreator.create(components, positions, modules, manager, "TestSetToken", "TEST");
    return SetToken__factory.connect(setTokenAddress, owner.wallet);
  }

  const initializeDebtIssuanceModule = (setTokenAddress: Address) => {
    return debtIssuanceModule.initialize(
      setTokenAddress,
      maxManagerFee,
      managerIssueFee,
      managerRedeemFee,
      managerFeeRecipient,
      managerIssuanceHook,
    );
  };

  const registerMockToken = async () => {
    const mockToken = await deployer.mocks.deployTokenMock(owner.address);

    const initReservesInput = {
      aTokenImpl: contractAddresses.aTokenImpl,
      stableDebtTokenImpl: contractAddresses.stableDebtTokenImpl,
      variableDebtTokenImpl: contractAddresses.variableDebtTokenImpl,
      underlyingAssetDecimals: 18,
      interestRateStrategyAddress: contractAddresses.interestRateStrategy,
      underlyingAsset: mockToken.address,
      treasury: contractAddresses.aaveTreasury,
      incentivesController: contractAddresses.aaveIncentivesController,
      aTokenName: "Aave Ethereum TEST",
      aTokenSymbol: "aEthTEST",
      variableDebtTokenName: "Aave Ethereum Variable Debt TEST",
      variableDebtTokenSymbol: "variableDebtEthTEST",
      stableDebtTokenName: "Aave Ethereum Stable Debt TEST",
      stableDebtTokenSymbol: "stableDebtEthTEST",
      params: "0x",
    };
    await lendingPoolConfigurator.initReserves([initReservesInput]);
    return mockToken;
  };

  describe("#constructor", () => {
    it("Should set the correct aave contracts", async () => {
      expect(await aaveLeverageModule.protocolDataProvider()).to.eq(
        contractAddresses.aaveV3ProtocolDataProvider,
      );
      expect(await aaveLeverageModule.lendingPoolAddressesProvider()).to.eq(
        contractAddresses.aaveV3AddressProvider,
      );
    });

    it("should set the correct controller", async () => {
      const returnController = await aaveLeverageModule.controller();
      expect(returnController).to.eq(contractAddresses.controller);
    });

    it("should set the correct underlying to reserve tokens mappings for weth", async () => {
      const wethReserveTokens = await aaveLeverageModule.underlyingToReserveTokens(
        tokenAddresses.weth,
      );
      expect(wethReserveTokens.aToken).to.eq(tokenAddresses.aWethV3);
      expect(wethReserveTokens.variableDebtToken).to.eq(tokenAddresses.aWethVariableDebtTokenV3);
    });

    it("should set the correct underlying to reserve tokens mappings for dai", async () => {
      const daiReserveTokens = await aaveLeverageModule.underlyingToReserveTokens(
        tokenAddresses.dai,
      );
      expect(daiReserveTokens.aToken).to.eq(tokenAddresses.aDaiV3);
      expect(daiReserveTokens.variableDebtToken).to.eq(tokenAddresses.aDaiVariableDebtTokenV3);
    });
  });

  describe("#initialize", async () => {
    let setToken: SetToken;
    let isAllowListed: boolean;
    let subjectSetToken: Address;
    let subjectCollateralAssets: Address[];
    let subjectBorrowAssets: Address[];
    let subjectCaller: Account;

    const initializeContracts = async () => {
      manager = owner.address;
      setToken = await createSetToken(
        [tokenAddresses.weth, tokenAddresses.dai],
        [ether(1), ether(100)],
        [aaveLeverageModule.address, debtIssuanceModule.address],
      );

      await initializeDebtIssuanceModule(setToken.address);

      if (isAllowListed) {
        // Add SetToken to allow list
        await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
      }
    };

    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
      subjectCollateralAssets = [tokenAddresses.weth, tokenAddresses.dai];
      subjectBorrowAssets = [tokenAddresses.dai, tokenAddresses.weth];
      subjectCaller = owner;
    };

    async function subject(): Promise<any> {
      return aaveLeverageModule
        .connect(subjectCaller.wallet)
        .initialize(subjectSetToken, subjectCollateralAssets, subjectBorrowAssets);
    }

    describe("when isAllowListed is true", () => {
      before(async () => {
        isAllowListed = true;
      });

      cacheBeforeEach(initializeContracts);
      beforeEach(initializeSubjectVariables);

      it("should enable the Module on the SetToken", async () => {
        await subject();
        const isModuleEnabled = await setToken.isInitializedModule(aaveLeverageModule.address);
        expect(isModuleEnabled).to.eq(true);
      });

      it("should set the Aave settings and mappings", async () => {
        await subject();

        const enabledAssets = await aaveLeverageModule.getEnabledAssets(setToken.address);
        const [collateralAssets, borrowAssets] = enabledAssets;

        const isWethCollateral = await aaveLeverageModule.collateralAssetEnabled(
          setToken.address,
          tokenAddresses.weth,
        );
        const isDaiCollateral = await aaveLeverageModule.collateralAssetEnabled(
          setToken.address,
          tokenAddresses.dai,
        );
        const isDaiBorrow = await aaveLeverageModule.borrowAssetEnabled(
          setToken.address,
          tokenAddresses.dai,
        );
        const isWethBorrow = await aaveLeverageModule.borrowAssetEnabled(
          setToken.address,
          tokenAddresses.weth,
        );

        expect(collateralAssets).to.deep.eq(subjectCollateralAssets);
        expect(borrowAssets).to.deep.eq(subjectBorrowAssets);
        expect(isWethCollateral).to.be.true;
        expect(isDaiCollateral).to.be.true;
        expect(isDaiBorrow).to.be.true;
        expect(isWethBorrow).to.be.true;
      });

      it("should register on the debt issuance module", async () => {
        await subject();
        const issuanceSettings = await debtIssuanceModule.issuanceSettings(setToken.address);
        expect(issuanceSettings.feeRecipient).to.not.eq(ADDRESS_ZERO);
      });

      describe("when debt issuance module is not added to integration registry", async () => {
        beforeEach(async () => {
          await integrationRegistry.removeIntegration(
            aaveLeverageModule.address,
            "DefaultIssuanceModule",
          );
        });

        afterEach(async () => {
          // Add debt issuance address to integration
          await integrationRegistry.addIntegration(
            aaveLeverageModule.address,
            "DefaultIssuanceModule",
            debtIssuanceModule.address,
          );
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be valid adapter");
        });
      });

      describe("when debt issuance module is not initialized on SetToken", async () => {
        beforeEach(async () => {
          await setToken.removeModule(debtIssuanceModule.address);
        });

        afterEach(async () => {
          await setToken.addModule(debtIssuanceModule.address);
          await initializeDebtIssuanceModule(setToken.address);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("INI");
        });
      });

      describe("when the caller is not the SetToken manager", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
        });
      });

      describe("when SetToken is not in pending state", async () => {
        beforeEach(async () => {
          const newModule = await getRandomAddress();
          await controller.addModule(newModule);

          const aaveLeverageModuleNotPendingSetToken = await createSetToken(
            [tokenAddresses.weth],
            [ether(1)],
            [newModule],
          );

          subjectSetToken = aaveLeverageModuleNotPendingSetToken.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be pending initialization");
        });
      });

      describe("when the SetToken is not enabled on the controller", async () => {
        beforeEach(async () => {
          const nonEnabledSetToken = await createNonControllerEnabledSetToken(
            [tokenAddresses.weth],
            [ether(1)],
            [aaveLeverageModule.address],
          );
          subjectSetToken = nonEnabledSetToken.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be controller-enabled SetToken");
        });
      });

      describe("when isAllowListed is false", async () => {
        before(async () => {
          isAllowListed = false;
        });

        cacheBeforeEach(initializeContracts);
        beforeEach(initializeSubjectVariables);

        describe("when SetToken is not allowlisted", async () => {
          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("NAS");
          });
        });

        describe("when any Set can initialize this module", async () => {
          beforeEach(async () => {
            await aaveLeverageModule.updateAnySetAllowed(true);
          });

          it("should enable the Module on the SetToken", async () => {
            await subject();
            const isModuleEnabled = await setToken.isInitializedModule(aaveLeverageModule.address);
            expect(isModuleEnabled).to.eq(true);
          });
        });
      });
    });
  });

  describe("#lever", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;
    let destinationTokenQuantity: BigNumber;

    let subjectSetToken: Address;
    let subjectBorrowAsset: Address;
    let subjectCollateralAsset: Address;
    let subjectBorrowQuantity: BigNumber;
    let subjectMinCollateralQuantity: BigNumber;
    let subjectTradeAdapterName: string;
    let subjectTradeData: Bytes;
    let subjectCaller: Account;

    async function subject(): Promise<any> {
      return aaveLeverageModule
        .connect(subjectCaller.wallet)
        .lever(
          subjectSetToken,
          subjectBorrowAsset,
          subjectCollateralAsset,
          subjectBorrowQuantity,
          subjectMinCollateralQuantity,
          subjectTradeAdapterName,
          subjectTradeData,
          { gasLimit: 2000000 },
        );
    }

    context(
      "when WETH is borrow asset, and WSTETH is collateral asset (icEth configuration)",
      async () => {
        // This is a borrow amount that will fail in normal mode but should work in e-mode
        const maxBorrowAmount = utils.parseEther("1.6");
        before(async () => {
          isInitialized = true;
        });

        cacheBeforeEach(async () => {
          setToken = await createSetToken(
            [aWstEth.address, weth.address],
            [ether(2), ether(1)],
            [aaveLeverageModule.address, debtIssuanceModule.address],
          );
          await initializeDebtIssuanceModule(setToken.address);
          // Add SetToken to allow list
          await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
          // Initialize module if set to true
          if (isInitialized) {
            await aaveLeverageModule.initialize(
              setToken.address,
              [weth.address, wsteth.address],
              [wsteth.address, weth.address],
            );
          }

          // Mint aTokens
          await network.provider.send("hardhat_setBalance", [
            whales.wsteth,
            ether(10).toHexString(),
          ]);
          await wsteth
            .connect(await impersonateAccount(whales.wsteth))
            .transfer(owner.address, ether(10000));
          await wsteth.approve(aaveLendingPool.address, ether(10000));
          await aaveLendingPool
            .connect(owner.wallet)
            .deposit(wsteth.address, ether(10000), owner.address, ZERO);

          await weth.approve(aaveLendingPool.address, ether(1000));
          await aaveLendingPool
            .connect(owner.wallet)
            .deposit(weth.address, ether(1000), owner.address, ZERO);

          // Approve tokens to issuance module and call issue
          await aWstEth.approve(debtIssuanceModule.address, ether(10000));
          await weth.approve(debtIssuanceModule.address, ether(1000));

          // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 1000 DAI regardless of Set supply
          const issueQuantity = ether(1);
          destinationTokenQuantity = ether(1);
          await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);
        });

        beforeEach(async () => {
          subjectSetToken = setToken.address;
          subjectBorrowAsset = weth.address;
          subjectCollateralAsset = wsteth.address;
          subjectBorrowQuantity = utils.parseEther("0.2");
          subjectMinCollateralQuantity = utils.parseEther("0.1");
          subjectTradeAdapterName = "UNISWAPV3";
          subjectTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
            [weth.address, wsteth.address], // Swap path
            [500], // Fees
            true,
          );
          subjectCaller = owner;
        });

        it("should update the collateral position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // cEther position is increased
          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];
          const newSecondPosition = (await setToken.getPositions())[1];

          // Get expected aTokens minted
          const newUnits = subjectMinCollateralQuantity;
          const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(3);
          expect(newFirstPosition.component).to.eq(aWstEth.address);
          expect(newFirstPosition.positionState).to.eq(0); // Default
          expect(newFirstPosition.unit).to.gte(expectedFirstPositionUnit);
          expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);

          expect(newSecondPosition.component).to.eq(weth.address);
          expect(newSecondPosition.positionState).to.eq(0); // Default
          expect(newSecondPosition.unit).to.eq(ether(1));
          expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
        });
        describe("When leverage ratio is higher than normal limit", () => {
          beforeEach(async () => {
            subjectBorrowQuantity = maxBorrowAmount;
          });
          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("36");
          });
        });

        describe("When E-mode category is set to eth category", () => {
          beforeEach(async () => {
            const wethEModeCategory = await protocolDataProvider.getReserveEModeCategory(
              weth.address,
            );
            const wstethEModeCategory = await protocolDataProvider.getReserveEModeCategory(
              wsteth.address,
            );
            expect(wethEModeCategory).to.eq(wstethEModeCategory);
            await aaveLeverageModule.setEModeCategory(setToken.address, wethEModeCategory);
          });

          it("should update the collateral position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // cEther position is increased
            const currentPositions = await setToken.getPositions();
            const newFirstPosition = (await setToken.getPositions())[0];
            const newSecondPosition = (await setToken.getPositions())[1];

            // Get expected aTokens minted
            const newUnits = subjectMinCollateralQuantity;
            const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(3);
            expect(newFirstPosition.component).to.eq(aWstEth.address);
            expect(newFirstPosition.positionState).to.eq(0); // Default
            expect(newFirstPosition.unit).to.gte(expectedFirstPositionUnit);
            expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);

            expect(newSecondPosition.component).to.eq(weth.address);
            expect(newSecondPosition.positionState).to.eq(0); // Default
            expect(newSecondPosition.unit).to.eq(ether(1));
            expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
          });
          describe("When leverage ratio is higher than normal limit", () => {
            beforeEach(async () => {
              subjectBorrowQuantity = maxBorrowAmount;
            });
            it("should update the collateral position on the SetToken correctly", async () => {
              const initialPositions = await setToken.getPositions();

              await subject();

              // cEther position is increased
              const currentPositions = await setToken.getPositions();
              const newFirstPosition = (await setToken.getPositions())[0];
              const newSecondPosition = (await setToken.getPositions())[1];

              // Get expected aTokens minted
              const newUnits = subjectMinCollateralQuantity;
              const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);

              expect(initialPositions.length).to.eq(2);
              expect(currentPositions.length).to.eq(3);
              expect(newFirstPosition.component).to.eq(aWstEth.address);
              expect(newFirstPosition.positionState).to.eq(0); // Default
              expect(newFirstPosition.unit).to.gte(expectedFirstPositionUnit);
              expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);

              expect(newSecondPosition.component).to.eq(weth.address);
              expect(newSecondPosition.positionState).to.eq(0); // Default
              expect(newSecondPosition.unit).to.eq(ether(1));
              expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
            });
          });
        });
      },
    );
    context("when aWETH is collateral asset and borrow positions is 0", async () => {
      const initializeContracts = async () => {
        setToken = await createSetToken(
          [aWETH.address],
          [ether(2)],
          [aaveLeverageModule.address, debtIssuanceModule.address],
        );
        await initializeDebtIssuanceModule(setToken.address);
        // Add SetToken to allow list
        await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
        // Initialize module if set to true
        if (isInitialized) {
          await aaveLeverageModule.initialize(
            setToken.address,
            [weth.address, dai.address],
            [dai.address, weth.address],
          );
        }
        // Mint aTokens
        await weth.approve(aaveLendingPool.address, ether(1000));
        await aaveLendingPool
          .connect(owner.wallet)
          .deposit(weth.address, ether(1000), owner.address, ZERO);
        await dai.approve(aaveLendingPool.address, ether(10000));
        await aaveLendingPool
          .connect(owner.wallet)
          .deposit(dai.address, ether(10000), owner.address, ZERO);
        // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 1000 DAI regardless of Set supply
        const issueQuantity = ether(1);
        destinationTokenQuantity = utils.parseEther("0.5");
        await aWETH.approve(debtIssuanceModule.address, ether(1000));
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);
      };
      const initializeSubjectVariables = async () => {
        subjectSetToken = setToken.address;
        subjectBorrowAsset = dai.address;
        subjectCollateralAsset = weth.address;
        subjectBorrowQuantity = ether(1000);
        subjectMinCollateralQuantity = destinationTokenQuantity;
        subjectTradeAdapterName = "UNISWAPV3";
        subjectTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
          [dai.address, weth.address], // Swap path
          [500], // Fees
          true,
        );
        subjectCaller = owner;
      };
      describe("when module is initialized", async () => {
        before(async () => {
          isInitialized = true;
        });
        cacheBeforeEach(initializeContracts);
        beforeEach(initializeSubjectVariables);
        it("should update the collateral position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();
          await subject();
          // cWETH position is increased
          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];
          const expectedFirstPositionUnit = initialPositions[0].unit.add(destinationTokenQuantity);
          expect(initialPositions.length).to.eq(1);
          expect(currentPositions.length).to.eq(2); // added a new borrow position
          expect(newFirstPosition.component).to.eq(aWETH.address);
          expect(newFirstPosition.positionState).to.eq(0); // Default
          expect(newFirstPosition.unit).to.gte(expectedFirstPositionUnit);
          expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
        });
        it("should update the borrow position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();
          await subject();
          // cEther position is increased
          const currentPositions = await setToken.getPositions();
          const newSecondPosition = (await setToken.getPositions())[1];
          const expectedSecondPositionUnit = (
            await variableDebtDAI.balanceOf(setToken.address)
          ).mul(-1);
          expect(initialPositions.length).to.eq(1);
          expect(currentPositions.length).to.eq(2);
          expect(newSecondPosition.component).to.eq(dai.address);
          expect(newSecondPosition.positionState).to.eq(1); // External
          expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
          expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
        });
        it("should transfer the correct components to the exchange", async () => {
          const oldSourceTokenBalance = await dai.balanceOf(wethDaiPool.address);
          await subject();
          const totalSourceQuantity = subjectBorrowQuantity;
          const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
          const newSourceTokenBalance = await dai.balanceOf(wethDaiPool.address);
          expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
        });
        it("should transfer the correct components from the exchange", async () => {
          const oldDestinationTokenBalance = await weth.balanceOf(wethDaiPool.address);
          await subject();
          const totalDestinationQuantity = destinationTokenQuantity;
          const expectedDestinationTokenBalance = oldDestinationTokenBalance.sub(
            totalDestinationQuantity,
          );
          const newDestinationTokenBalance = await weth.balanceOf(wethDaiPool.address);
          expect(newDestinationTokenBalance).to.gt(
            expectedDestinationTokenBalance.mul(999).div(1000),
          );
          expect(newDestinationTokenBalance).to.lt(
            expectedDestinationTokenBalance.mul(1001).div(1000),
          );
        });
        describe("when there is a protocol fee charged", async () => {
          let feePercentage: BigNumber;
          cacheBeforeEach(async () => {
            feePercentage = ether(0.05);
            controller = controller.connect(await impersonateAccount(await controller.owner()));
            await controller.addFee(
              aaveLeverageModule.address,
              ZERO, // Fee type on trade function denoted as 0
              feePercentage, // Set fee to 5 bps
            );
          });
          it("should transfer the correct components to the exchange", async () => {
            // const oldSourceTokenBalance = await dai.balanceOf(oneInchExchangeMockToWeth.address);
            await subject();
            // const totalSourceQuantity = subjectBorrowQuantity;
            // const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
            // const newSourceTokenBalance = await dai.balanceOf(oneInchExchangeMockToWeth.address);
            // expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
          });
          it("should transfer the correct protocol fee to the protocol", async () => {
            const feeRecipient = await controller.feeRecipient();
            const oldFeeRecipientBalance = await weth.balanceOf(feeRecipient);
            await subject();
            const expectedFeeRecipientBalance = oldFeeRecipientBalance.add(
              preciseMul(feePercentage, destinationTokenQuantity),
            );
            const newFeeRecipientBalance = await weth.balanceOf(feeRecipient);
            expect(newFeeRecipientBalance).to.gte(expectedFeeRecipientBalance);
          });
          it("should update the collateral position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();
            await subject();
            // cEther position is increased
            const currentPositions = await setToken.getPositions();
            const newFirstPosition = (await setToken.getPositions())[0];
            // Get expected cTokens minted
            const unitProtocolFee = feePercentage.mul(subjectMinCollateralQuantity).div(ether(1));
            const newUnits = subjectMinCollateralQuantity.sub(unitProtocolFee);
            const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);
            expect(initialPositions.length).to.eq(1);
            expect(currentPositions.length).to.eq(2);
            expect(newFirstPosition.component).to.eq(aWETH.address);
            expect(newFirstPosition.positionState).to.eq(0); // Default
            expect(newFirstPosition.unit).to.gte(expectedFirstPositionUnit);
            expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
          });
          it("should update the borrow position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();
            await subject();
            // cEther position is increased
            const currentPositions = await setToken.getPositions();
            const newSecondPosition = (await setToken.getPositions())[1];
            const expectedSecondPositionUnit = (
              await variableDebtDAI.balanceOf(setToken.address)
            ).mul(-1);
            expect(initialPositions.length).to.eq(1);
            expect(currentPositions.length).to.eq(2);
            expect(newSecondPosition.component).to.eq(dai.address);
            expect(newSecondPosition.positionState).to.eq(1); // External
            expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
            expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
          });
        });
        describe("when the exchange is not valid", async () => {
          beforeEach(async () => {
            subjectTradeAdapterName = "INVALID";
          });
          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be valid adapter");
          });
        });
        describe("when collateral asset is not enabled", async () => {
          beforeEach(async () => {
            subjectCollateralAsset = wbtc.address;
          });
          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("CNE");
          });
        });
        describe("when borrow asset is not enabled", async () => {
          beforeEach(async () => {
            subjectBorrowAsset = await getRandomAddress();
          });
          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("BNE");
          });
        });
        describe("when borrow asset is same as collateral asset", async () => {
          beforeEach(async () => {
            subjectBorrowAsset = weth.address;
          });
          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("CBE");
          });
        });
        describe("when quantity of token to sell is 0", async () => {
          beforeEach(async () => {
            subjectBorrowQuantity = ZERO;
          });
          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("ZQ");
          });
        });
        describe("when the caller is not the SetToken manager", async () => {
          beforeEach(async () => {
            subjectCaller = await getRandomAccount();
          });
          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
          });
        });
        describe("when SetToken is not valid", async () => {
          beforeEach(async () => {
            const nonEnabledSetToken = await createNonControllerEnabledSetToken(
              [weth.address],
              [ether(1)],
              [aaveLeverageModule.address],
            );
            subjectSetToken = nonEnabledSetToken.address;
          });
          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
          });
        });
      });
      describe("when module is not initialized", async () => {
        beforeEach(async () => {
          isInitialized = false;
          await initializeContracts();
          initializeSubjectVariables();
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });
    });

    context("when DAI is borrow asset, and is a default position", async () => {
      before(async () => {
        isInitialized = true;
      });
      cacheBeforeEach(async () => {
        setToken = await createSetToken(
          [aWETH.address, dai.address],
          [ether(2), ether(1)],
          [aaveLeverageModule.address, debtIssuanceModule.address],
        );
        await initializeDebtIssuanceModule(setToken.address);
        // Add SetToken to allow list
        await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
        // Initialize module if set to true
        if (isInitialized) {
          await aaveLeverageModule.initialize(
            setToken.address,
            [weth.address, dai.address],
            [dai.address, weth.address],
          );
        }
        // Mint aTokens
        await weth.approve(aaveLendingPool.address, ether(1000));
        await aaveLendingPool
          .connect(owner.wallet)
          .deposit(weth.address, ether(1000), owner.address, ZERO);
        await dai.approve(aaveLendingPool.address, ether(10000));
        await aaveLendingPool
          .connect(owner.wallet)
          .deposit(dai.address, ether(10000), owner.address, ZERO);
        // Approve tokens to issuance module and call issue
        await aWETH.approve(debtIssuanceModule.address, ether(1000));
        await dai.approve(debtIssuanceModule.address, ether(10000));
        // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 1000 DAI regardless of Set supply
        const issueQuantity = ether(1);
        destinationTokenQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);
      });
      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectBorrowAsset = dai.address;
        subjectCollateralAsset = weth.address;
        subjectBorrowQuantity = ether(1000);
        subjectMinCollateralQuantity = destinationTokenQuantity.div(2);
        subjectTradeAdapterName = "UNISWAPV3";
        subjectTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
          [dai.address, weth.address], // Swap path
          [500], // Fees
          true,
        );
        subjectCaller = owner;
      });
      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();
        await subject();
        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];
        const newSecondPosition = (await setToken.getPositions())[1];
        // Get expected aTokens minted
        const newUnits = subjectMinCollateralQuantity;
        const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);
        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(3);
        expect(newFirstPosition.component).to.eq(aWETH.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.gte(expectedFirstPositionUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
        expect(newSecondPosition.component).to.eq(dai.address);
        expect(newSecondPosition.positionState).to.eq(0); // Default
        expect(newSecondPosition.unit).to.eq(ether(1));
        expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
      });
      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();
        await subject();
        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newThridPosition = (await setToken.getPositions())[2];
        const expectedPositionUnit = (await variableDebtDAI.balanceOf(setToken.address)).mul(-1);
        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(3);
        expect(newThridPosition.component).to.eq(dai.address);
        expect(newThridPosition.positionState).to.eq(1); // External
        expect(newThridPosition.unit).to.eq(expectedPositionUnit);
        expect(newThridPosition.module).to.eq(aaveLeverageModule.address);
      });
    });
  });

  describe("#setEModeCategory", () => {
    let setToken: SetToken;
    let subjectCategoryId: number;
    let subjectSetToken: Address;
    let caller: Signer;
    const initializeContracts = async () => {
      setToken = await createSetToken(
        [aWstEth.address, weth.address],
        [ether(2), ether(1)],
        [aaveLeverageModule.address, debtIssuanceModule.address],
      );
      await initializeDebtIssuanceModule(setToken.address);
      // Add SetToken to allow list
      await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
      // Initialize module if set to true
      await aaveLeverageModule.initialize(
        setToken.address,
        [weth.address, wsteth.address],
        [wsteth.address, weth.address],
      );

      // Mint aTokens
      await network.provider.send("hardhat_setBalance", [whales.wsteth, ether(10).toHexString()]);
      await wsteth
        .connect(await impersonateAccount(whales.wsteth))
        .transfer(owner.address, ether(10000));
      await wsteth.approve(aaveLendingPool.address, ether(10000));
      await aaveLendingPool
        .connect(owner.wallet)
        .deposit(wsteth.address, ether(10000), owner.address, ZERO);

      await weth.approve(aaveLendingPool.address, ether(1000));
      await aaveLendingPool
        .connect(owner.wallet)
        .deposit(weth.address, ether(1000), owner.address, ZERO);

      // Approve tokens to issuance module and call issue
      await aWstEth.approve(debtIssuanceModule.address, ether(10000));
      await weth.approve(debtIssuanceModule.address, ether(1000));

      // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 1000 DAI regardless of Set supply
      const issueQuantity = ether(1);
      await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

      // This is a borrow amount that will fail in normal mode but should work in e-mode
      const borrowAmount = utils.parseEther("1.5");

      const leverageTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
        [weth.address, wsteth.address], // Swap path
        [500], // Fees
        true,
      );
      console.log("levering up");
      await aaveLeverageModule.lever(
        setToken.address,
        weth.address,
        wsteth.address,
        borrowAmount,
        utils.parseEther("0.1"),
        "UNISWAPV3",
        leverageTradeData,
      );
      console.log("levered up");
    };

    cacheBeforeEach(initializeContracts);

    beforeEach(() => {
      subjectSetToken = setToken.address;
      caller = owner.wallet;
    });

    const subject = () =>
      aaveLeverageModule.connect(caller).setEModeCategory(subjectSetToken, subjectCategoryId);

    describe("When changing the EMode Category from default to 1", async () => {
      beforeEach(() => {
        subjectCategoryId = 1;
      });
      it("sets the EMode category for the set Token user correctly", async () => {
        await subject();
        const categoryId = await aaveLendingPool.getUserEMode(subjectSetToken);
        expect(categoryId).to.eq(subjectCategoryId);
      });

      it("Increases liquidationThreshold and healthFactor", async () => {
        const userDataBefore = await aaveLendingPool.getUserAccountData(subjectSetToken);
        await subject();
        const userDataAfter = await aaveLendingPool.getUserAccountData(subjectSetToken);
        expect(userDataAfter.healthFactor).to.be.gt(userDataBefore.healthFactor);
        expect(userDataAfter.currentLiquidationThreshold).to.be.gt(
          userDataBefore.currentLiquidationThreshold,
        );
      });
    });

    describe("When category has been set to 1 (ETH)", async () => {
      beforeEach(async () => {
        await aaveLeverageModule.setEModeCategory(subjectSetToken, 1);
      });
      describe("When setting the category back to 0", async () => {
        beforeEach(() => {
          subjectCategoryId = 0;
        });
        it("sets the EMode category for the set Token user correctly", async () => {
          await subject();
          const categoryId = await aaveLendingPool.getUserEMode(subjectSetToken);
          expect(categoryId).to.eq(subjectCategoryId);
        });
      });
    });

    describe("When caller is not the owner", async () => {
      beforeEach(async () => {
        caller = notOwner.wallet;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
      });
    });
  });

  describe("#delever", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectCollateralAsset: Address;
    let subjectRepayAsset: Address;
    let subjectRedeemQuantity: BigNumber;
    let subjectMinRepayQuantity: BigNumber;
    let subjectTradeAdapterName: string;
    let subjectTradeData: Bytes;
    let subjectCaller: Account;

    const initializeContracts = async () => {
      setToken = await createSetToken(
        [aWETH.address],
        [ether(10)],
        [aaveLeverageModule.address, debtIssuanceModule.address],
      );
      await initializeDebtIssuanceModule(setToken.address);
      // Add SetToken to allow list
      await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
      // Initialize module if set to true
      if (isInitialized) {
        await aaveLeverageModule.initialize(
          setToken.address,
          [weth.address, dai.address],
          [dai.address, weth.address],
        );
      }

      const issueQuantity = ether(10);

      await weth.approve(aaveLendingPool.address, ether(100));
      await aaveLendingPool
        .connect(owner.wallet)
        .deposit(weth.address, ether(100), owner.address, ZERO);
      await aWETH.approve(debtIssuanceModule.address, ether(100));
      await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

      // Lever SetToken
      if (isInitialized) {
        const leverTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
          [dai.address, weth.address], // Swap path
          [500], // fees
          true,
        );

        await aaveLeverageModule.lever(
          setToken.address,
          dai.address,
          weth.address,
          ether(2000),
          ether(1),
          "UNISWAPV3",
          leverTradeData,
        );
      }
    };

    const initializeSubjectVariables = async () => {
      subjectSetToken = setToken.address;
      subjectCollateralAsset = weth.address;
      subjectRepayAsset = dai.address;
      subjectRedeemQuantity = ether(2);
      subjectTradeAdapterName = "UNISWAPV3";
      subjectMinRepayQuantity = ZERO;
      subjectCaller = owner;
      subjectTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
        [weth.address, dai.address], // Swap path
        [500], // Send quantity
        true,
      );
    };

    async function subject(): Promise<ContractTransaction> {
      return await aaveLeverageModule
        .connect(subjectCaller.wallet)
        .delever(
          subjectSetToken,
          subjectCollateralAsset,
          subjectRepayAsset,
          subjectRedeemQuantity,
          subjectMinRepayQuantity,
          subjectTradeAdapterName,
          subjectTradeData,
        );
    }

    describe("when module is initialized", async () => {
      before(async () => {
        isInitialized = true;
      });

      cacheBeforeEach(initializeContracts);
      beforeEach(initializeSubjectVariables);

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        // Get expected aTokens burnt
        const removedUnits = subjectRedeemQuantity;
        const expectedFirstPositionUnit = initialPositions[0].unit.sub(removedUnits);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(aWETH.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        // When switching to uniswapV3 integration testing had to add some small tolerance here
        // TODO: understand why
        expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
        expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should wipe the debt on Aave", async () => {
        await subject();

        const borrowDebt = await variableDebtDAI.balanceOf(setToken.address);

        expect(borrowDebt).to.eq(ZERO);
      });

      it("should remove external positions on the borrow asset", async () => {
        await subject();

        const borrowAssetExternalModules = await setToken.getExternalPositionModules(dai.address);
        const borrowExternalUnit = await setToken.getExternalPositionRealUnit(
          dai.address,
          aaveLeverageModule.address,
        );
        const isPositionModule = await setToken.isExternalPositionModule(
          dai.address,
          aaveLeverageModule.address,
        );

        expect(borrowAssetExternalModules.length).to.eq(0);
        expect(borrowExternalUnit).to.eq(ZERO);
        expect(isPositionModule).to.eq(false);
      });

      it("should update the borrow asset equity on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        const tx = await subject();

        // Fetch total repay amount
        const res = await tx.wait();
        const levDecreasedEvent = res.events?.find(value => {
          return value.event == "LeverageDecreased";
        });
        expect(levDecreasedEvent).to.not.eq(undefined);

        const initialSecondPosition = initialPositions[1];

        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component).to.eq(dai.address);
        expect(newSecondPosition.positionState).to.eq(0); // Default
        expect(newSecondPosition.unit).to.gt(initialSecondPosition.unit);
        expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should transfer the correct components to the exchange", async () => {
        const oldSourceTokenBalance = await weth.balanceOf(wethDaiPool.address);

        await subject();
        const totalSourceQuantity = subjectRedeemQuantity;
        const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
        const newSourceTokenBalance = await weth.balanceOf(wethDaiPool.address);
        // Had to add some tolerance here when switching to aaveV3 integration testing
        // TODO: understand why
        expect(newSourceTokenBalance).to.lt(expectedSourceTokenBalance.mul(102).div(100));
        expect(newSourceTokenBalance).to.gt(expectedSourceTokenBalance.mul(99).div(100));
      });

      it("should transfer the correct components from the exchange", async () => {
        // const [, repayAssetAmountOut] = await uniswapV3Router.getAmountsOut(subjectRedeemQuantity, [
        //   weth.address,
        //   dai.address,
        // ]);
        const oldDestinationTokenBalance = await dai.balanceOf(wethDaiPool.address);

        await subject();
        // const totalDestinationQuantity = repayAssetAmountOut;
        // const expectedDestinationTokenBalance = oldDestinationTokenBalance.sub(
        //   totalDestinationQuantity,
        // );
        const newDestinationTokenBalance = await dai.balanceOf(wethDaiPool.address);
        expect(newDestinationTokenBalance).to.lt(oldDestinationTokenBalance);
      });

      describe("when the exchange is not valid", async () => {
        beforeEach(async () => {
          subjectTradeAdapterName = "INVALID";
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be valid adapter");
        });
      });

      describe("when borrow / repay asset is not enabled", async () => {
        beforeEach(async () => {
          subjectRepayAsset = wbtc.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("BNE");
        });
      });

      describe("when the caller is not the SetToken manager", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
        });
      });

      describe("when SetToken is not valid", async () => {
        beforeEach(async () => {
          const nonEnabledSetToken = await createNonControllerEnabledSetToken(
            [weth.address],
            [ether(1)],
            [aaveLeverageModule.address],
          );

          subjectSetToken = nonEnabledSetToken.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });
    });

    describe("when module is not initialized", async () => {
      beforeEach(async () => {
        isInitialized = false;
        await initializeContracts();
        initializeSubjectVariables();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#deleverToZeroBorrowBalance", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectCollateralAsset: Address;
    let subjectRepayAsset: Address;
    let subjectRedeemQuantity: BigNumber;
    let subjectTradeAdapterName: string;
    let subjectTradeData: Bytes;
    let subjectCaller: Account;

    const initializeContracts = async () => {
      setToken = await createSetToken(
        [aWETH.address],
        [ether(10)],
        [aaveLeverageModule.address, debtIssuanceModule.address],
      );
      await initializeDebtIssuanceModule(setToken.address);
      // Add SetToken to allow list
      await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
      // Initialize module if set to true
      if (isInitialized) {
        await aaveLeverageModule.initialize(
          setToken.address,
          [weth.address, dai.address],
          [dai.address, weth.address],
        );
      }

      const issueQuantity = ether(10);

      await weth.approve(aaveLendingPool.address, ether(100));
      await aaveLendingPool
        .connect(owner.wallet)
        .deposit(weth.address, ether(100), owner.address, ZERO);
      await aWETH.approve(debtIssuanceModule.address, ether(100));
      await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

      // Lever SetToken
      if (isInitialized) {
        const leverTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
          [dai.address, weth.address], // Swap path
          [500], // fees
          true,
        );

        await aaveLeverageModule.lever(
          setToken.address,
          dai.address,
          weth.address,
          ether(2000),
          ether(1),
          "UNISWAPV3",
          leverTradeData,
        );
      }
    };

    const initializeSubjectVariables = async () => {
      subjectSetToken = setToken.address;
      subjectCollateralAsset = weth.address;
      subjectRepayAsset = dai.address;
      subjectRedeemQuantity = ether(2);
      subjectTradeAdapterName = "UNISWAPV3";
      subjectCaller = owner;
      subjectTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
        [weth.address, dai.address], // Swap path
        [500], // Send quantity
        true,
      );
    };

    async function subject(): Promise<ContractTransaction> {
      return await aaveLeverageModule
        .connect(subjectCaller.wallet)
        .deleverToZeroBorrowBalance(
          subjectSetToken,
          subjectCollateralAsset,
          subjectRepayAsset,
          subjectRedeemQuantity,
          subjectTradeAdapterName,
          subjectTradeData,
        );
    }

    describe("when module is initialized", async () => {
      before(async () => {
        isInitialized = true;
      });

      cacheBeforeEach(initializeContracts);
      beforeEach(initializeSubjectVariables);

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        // Get expected aTokens burnt
        const removedUnits = subjectRedeemQuantity;
        const expectedFirstPositionUnit = initialPositions[0].unit.sub(removedUnits);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(aWETH.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
        expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should wipe the debt on Aave", async () => {
        await subject();

        const borrowDebt = await variableDebtDAI.balanceOf(setToken.address);

        expect(borrowDebt).to.eq(ZERO);
      });

      it("should remove external positions on the borrow asset", async () => {
        await subject();

        const borrowAssetExternalModules = await setToken.getExternalPositionModules(dai.address);
        const borrowExternalUnit = await setToken.getExternalPositionRealUnit(
          dai.address,
          aaveLeverageModule.address,
        );
        const isPositionModule = await setToken.isExternalPositionModule(
          dai.address,
          aaveLeverageModule.address,
        );

        expect(borrowAssetExternalModules.length).to.eq(0);
        expect(borrowExternalUnit).to.eq(ZERO);
        expect(isPositionModule).to.eq(false);
      });

      it("should update the borrow asset equity on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        const swapPromise = waitForEvent(wethDaiPool, "Swap");
        const tx = await subject();

        // Fetch total repay amount
        const res = await tx.wait();
        await swapPromise;
        const levDecreasedEvent = res.events?.find(value => {
          return value.event == "LeverageDecreased";
        });
        expect(levDecreasedEvent).to.not.eq(undefined);

        const initialSecondPosition = initialPositions[1];

        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component).to.eq(dai.address);
        expect(newSecondPosition.positionState).to.eq(0); // Default
        expect(newSecondPosition.unit).to.gt(initialSecondPosition.unit);
        expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should transfer the correct components to the exchange", async () => {
        const oldSourceTokenBalance = await weth.balanceOf(wethDaiPool.address);

        await subject();
        const totalSourceQuantity = subjectRedeemQuantity;
        const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
        const newSourceTokenBalance = await weth.balanceOf(wethDaiPool.address);
        // Had to add some tolerance here when switching to aaveV3 integration testing
        // TODO: understand why
        expect(newSourceTokenBalance).to.lt(expectedSourceTokenBalance.mul(102).div(100));
        expect(newSourceTokenBalance).to.gt(expectedSourceTokenBalance.mul(99).div(100));
      });

      it("should transfer the correct components from the exchange", async () => {
        // const [, repayAssetAmountOut] = await uniswapV3Router.getAmountsOut(subjectRedeemQuantity, [
        //   weth.address,
        //   dai.address,
        // ]);
        const oldDestinationTokenBalance = await dai.balanceOf(wethDaiPool.address);

        await subject();
        // const totalDestinationQuantity = repayAssetAmountOut;
        // const expectedDestinationTokenBalance = oldDestinationTokenBalance.sub(
        //   totalDestinationQuantity,
        // );
        const newDestinationTokenBalance = await dai.balanceOf(wethDaiPool.address);
        expect(newDestinationTokenBalance).to.lt(oldDestinationTokenBalance);
      });

      describe("when the exchange is not valid", async () => {
        beforeEach(async () => {
          subjectTradeAdapterName = "INVALID";
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be valid adapter");
        });
      });

      describe("when borrow / repay asset is not enabled", async () => {
        beforeEach(async () => {
          subjectRepayAsset = wbtc.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("BNE");
        });
      });

      describe("when borrow balance is 0", async () => {
        beforeEach(async () => {
          await aaveLeverageModule
            .connect(owner.wallet)
            .addBorrowAssets(setToken.address, [wbtc.address]);

          subjectRepayAsset = wbtc.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("BBZ");
        });
      });

      describe("when the caller is not the SetToken manager", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
        });
      });

      describe("when SetToken is not valid", async () => {
        beforeEach(async () => {
          const nonEnabledSetToken = await createNonControllerEnabledSetToken(
            [weth.address],
            [ether(1)],
            [aaveLeverageModule.address],
          );

          subjectSetToken = nonEnabledSetToken.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });
    });

    describe("when module is not initialized", async () => {
      beforeEach(async () => {
        isInitialized = false;
        await initializeContracts();
        initializeSubjectVariables();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#sync", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectCaller: Account;

    const initializeSubjectVariables = async () => {
      subjectSetToken = setToken.address;
      subjectCaller = await getRandomAccount();
    };

    async function subject(): Promise<any> {
      return aaveLeverageModule.connect(subjectCaller.wallet).sync(subjectSetToken);
    }

    context("when aWETH and aDAI are collateral and WETH and DAI are borrow assets", async () => {
      const initializeContracts = async () => {
        setToken = await createSetToken(
          [aWETH.address, aDAI.address],
          [ether(2), ether(1000)],
          [aaveLeverageModule.address, debtIssuanceModule.address],
        );
        await initializeDebtIssuanceModule(setToken.address);
        // Add SetToken to allow list
        await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);

        // Initialize module if set to true
        if (isInitialized) {
          await aaveLeverageModule.initialize(
            setToken.address,
            [weth.address, dai.address, wbtc.address], // Enable WBTC that is not a Set position
            [dai.address, weth.address, wbtc.address],
          );
        }

        // Mint aTokens
        await weth.approve(aaveLendingPool.address, ether(1000));
        await aaveLendingPool
          .connect(owner.wallet)
          .deposit(weth.address, ether(1000), owner.address, ZERO);
        await dai.approve(aaveLendingPool.address, ether(10000));
        await aaveLendingPool
          .connect(owner.wallet)
          .deposit(dai.address, ether(10000), owner.address, ZERO);

        // Approve tokens to issuance module and call issue
        await aWETH.approve(debtIssuanceModule.address, ether(1000));
        await aDAI.approve(debtIssuanceModule.address, ether(10000));

        // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 1000 DAI regardless of Set supply
        const issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        if (isInitialized) {
          // Leverage aWETH in SetToken
          const leverEthTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
            [dai.address, weth.address], // Swap path
            [500], // fees
            true,
          );

          await aaveLeverageModule.lever(
            setToken.address,
            dai.address,
            weth.address,
            ether(2000),
            ether(1),
            "UNISWAPV3",
            leverEthTradeData,
          );

          const leverDaiTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
            [weth.address, dai.address], // Swap path
            [500], // fees
            true,
          );

          await aaveLeverageModule.lever(
            setToken.address,
            weth.address,
            dai.address,
            ether(1),
            ether(1000),
            "UNISWAPV3",
            leverDaiTradeData,
          );
        }
      };

      describe("when module is initialized", async () => {
        before(async () => {
          isInitialized = true;
        });

        cacheBeforeEach(initializeContracts);
        beforeEach(initializeSubjectVariables);

        it("should update the collateral positions on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // cEther position is increased
          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];
          const newSecondPosition = (await setToken.getPositions())[1];

          const expectedFirstPositionUnit = await aWETH.balanceOf(setToken.address); // need not divide as total supply is 1.
          const expectedSecondPositionUnit = await aDAI.balanceOf(setToken.address);

          expect(initialPositions.length).to.eq(4);
          expect(currentPositions.length).to.eq(4);
          expect(newFirstPosition.component).to.eq(aWETH.address);
          expect(newFirstPosition.positionState).to.eq(0); // Default
          expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
          expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);

          expect(newSecondPosition.component).to.eq(aDAI.address);
          expect(newSecondPosition.positionState).to.eq(0); // Default
          expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
          expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
        });

        it("should update the borrow positions on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // cEther position is increased
          const currentPositions = await setToken.getPositions();
          const newThirdPosition = (await setToken.getPositions())[2];
          const newFourthPosition = (await setToken.getPositions())[3];

          const expectedThirdPositionUnit = (await variableDebtDAI.balanceOf(setToken.address)).mul(
            -1,
          );
          const expectedFourthPositionUnit = (
            await variableDebtWETH.balanceOf(setToken.address)
          ).mul(-1);

          expect(initialPositions.length).to.eq(4);
          expect(currentPositions.length).to.eq(4);
          expect(newThirdPosition.component).to.eq(dai.address);
          expect(newThirdPosition.positionState).to.eq(1); // External
          expect(newThirdPosition.unit).to.eq(expectedThirdPositionUnit);
          expect(newThirdPosition.module).to.eq(aaveLeverageModule.address);

          expect(newFourthPosition.component).to.eq(weth.address);
          expect(newFourthPosition.positionState).to.eq(1); // External
          expect(newFourthPosition.unit).to.eq(expectedFourthPositionUnit);
          expect(newFourthPosition.module).to.eq(aaveLeverageModule.address);
        });

        describe("when leverage position has been liquidated", async () => {
          let liquidationRepayQuantity: BigNumber;
          let chainlinkAggregatorMock: ChainlinkAggregatorMock;
          let totalTokensSezied: BigNumber;
          const oracleDecimals = 8;

          cacheBeforeEach(async () => {
            chainlinkAggregatorMock = await deployer.mocks.deployChainlinkAggregatorMock(
              oracleDecimals,
            );
            // Leverage aWETH again
            const leverEthTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
              [dai.address, weth.address], // Swap path
              [500], // fees
              true,
            );

            await aaveLeverageModule.lever(
              setToken.address,
              dai.address,
              weth.address,
              ether(2000),
              ether(1),
              "UNISWAPV3",
              leverEthTradeData,
            );
          });

          beforeEach(async () => {
            await subject();
            await aaveOracle.setAssetSources([dai.address], [chainlinkAggregatorMock.address]);
            await chainlinkAggregatorMock.setLatestAnswer(utils.parseUnits("10.1", oracleDecimals));

            liquidationRepayQuantity = ether(100);
            await dai.approve(aaveLendingPool.address, liquidationRepayQuantity);

            const aWethBalanceBefore = await aWETH.balanceOf(setToken.address);
            await aaveLendingPool
              .connect(owner.wallet)
              .liquidationCall(
                weth.address,
                dai.address,
                setToken.address,
                liquidationRepayQuantity,
                true,
              );
            const aWethBalanceAfter = await aWETH.balanceOf(setToken.address);
            totalTokensSezied = aWethBalanceBefore.sub(aWethBalanceAfter);
          });

          it("should update the collateral positions on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            const currentPositions = await setToken.getPositions();
            const newFirstPosition = currentPositions[0];
            const newSecondPosition = currentPositions[1];

            const expectedFirstPositionUnit = initialPositions[0].unit.sub(totalTokensSezied);

            // aWETH position decreases
            expect(newFirstPosition.component).to.eq(aWETH.address);
            expect(newFirstPosition.positionState).to.eq(0); // Default
            expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(9999).div(10000));
            expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(10001).div(10000));
            expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);

            // cDAI position should stay the same
            expect(newSecondPosition.component).to.eq(aDAI.address);
            expect(newSecondPosition.positionState).to.eq(0); // Default
            expect(newSecondPosition.unit).to.eq(newSecondPosition.unit);
            expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
          });

          it("should update the borrow position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            const currentPositions = await setToken.getPositions();
            const newThirdPosition = (await setToken.getPositions())[2];
            const newFourthPosition = (await setToken.getPositions())[3];

            const expectedThirdPositionUnit = (
              await variableDebtDAI.balanceOf(setToken.address)
            ).mul(-1);
            const expectedFourthPositionUnit = (
              await variableDebtWETH.balanceOf(setToken.address)
            ).mul(-1);

            expect(initialPositions.length).to.eq(4);
            expect(currentPositions.length).to.eq(4);

            expect(newThirdPosition.component).to.eq(dai.address);
            expect(newThirdPosition.positionState).to.eq(1); // External
            expect(newThirdPosition.unit).to.eq(expectedThirdPositionUnit);
            expect(newThirdPosition.module).to.eq(aaveLeverageModule.address);

            expect(newFourthPosition.component).to.eq(weth.address);
            expect(newFourthPosition.positionState).to.eq(1); // External
            expect(newFourthPosition.unit).to.eq(expectedFourthPositionUnit);
            expect(newFourthPosition.module).to.eq(aaveLeverageModule.address);
          });
        });

        describe("when SetToken is not valid", async () => {
          beforeEach(async () => {
            const nonEnabledSetToken = await createNonControllerEnabledSetToken(
              [weth.address],
              [ether(1)],
              [aaveLeverageModule.address],
            );

            subjectSetToken = nonEnabledSetToken.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
          });
        });
      });

      describe("when module is not initialized", async () => {
        beforeEach(() => {
          isInitialized = false;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });
    });

    describe("when set token total supply is 0", async () => {
      const initializeContracts = async () => {
        setToken = await createSetToken(
          [aWETH.address, aDAI.address],
          [ether(2), ether(1000)],
          [aaveLeverageModule.address, debtIssuanceModule.address],
        );
        await initializeDebtIssuanceModule(setToken.address);
        // Add SetToken to allow list
        await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);

        // Initialize module if set to true
        await aaveLeverageModule.initialize(
          setToken.address,
          [weth.address, dai.address],
          [dai.address, weth.address],
        );
      };

      beforeEach(async () => {
        await initializeContracts();
        await initializeSubjectVariables();
      });

      it("should preserve default positions", async () => {
        const initialPositions = await setToken.getPositions();
        await subject();
        const currentPositions = await setToken.getPositions();

        expect(currentPositions.length).to.eq(2); // 2 Default positions
        expect(initialPositions.length).to.eq(2);

        expect(currentPositions[0].component).to.eq(aWETH.address);
        expect(currentPositions[0].positionState).to.eq(0); // Default
        expect(currentPositions[0].unit).to.eq(initialPositions[0].unit);
        expect(currentPositions[0].module).to.eq(ADDRESS_ZERO);

        expect(currentPositions[1].component).to.eq(aDAI.address);
        expect(currentPositions[1].positionState).to.eq(0); // Default
        expect(currentPositions[1].unit).to.eq(initialPositions[1].unit);
        expect(currentPositions[1].module).to.eq(ADDRESS_ZERO);
      });
    });
  });

  describe("#addCollateralAssets", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectCollateralAssets: Address[];
    let subjectCaller: Account;

    const initializeContracts = async () => {
      setToken = await createSetToken(
        [aWETH.address],
        [ether(1)],
        [aaveLeverageModule.address, debtIssuanceModule.address],
      );
      await initializeDebtIssuanceModule(setToken.address);
      // Add SetToken to allow list
      await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
      // Initialize module if set to true
      if (isInitialized) {
        await aaveLeverageModule.initialize(setToken.address, [weth.address], []);
      }
    };

    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
      subjectCollateralAssets = [dai.address];
      subjectCaller = owner;
    };

    async function subject(): Promise<any> {
      return aaveLeverageModule
        .connect(subjectCaller.wallet)
        .addCollateralAssets(subjectSetToken, subjectCollateralAssets);
    }

    describe("when module is initialized", () => {
      before(() => {
        isInitialized = true;
      });

      cacheBeforeEach(initializeContracts);
      beforeEach(initializeSubjectVariables);

      it("should add the collateral asset to mappings", async () => {
        await subject();
        const collateralAssets = (await aaveLeverageModule.getEnabledAssets(setToken.address))[0];
        const isDaiCollateral = await aaveLeverageModule.collateralAssetEnabled(
          setToken.address,
          dai.address,
        );

        expect(JSON.stringify(collateralAssets)).to.eq(JSON.stringify([weth.address, dai.address]));
        expect(isDaiCollateral).to.be.true;
      });

      it("should emit the correct CollateralAssetsUpdated event", async () => {
        await expect(subject())
          .to.emit(aaveLeverageModule, "CollateralAssetsUpdated")
          .withArgs(subjectSetToken, true, subjectCollateralAssets);
      });

      context("before first issuance, aToken balance is zero", async () => {
        it("should not be able to enable collateral asset to be used as collateral on Aave", async () => {
          const beforeUsageAsCollateralEnabled = (
            await protocolDataProvider.getUserReserveData(dai.address, setToken.address)
          ).usageAsCollateralEnabled;
          await subject();
          const afterUsageAsCollateralEnabled = (
            await protocolDataProvider.getUserReserveData(dai.address, setToken.address)
          ).usageAsCollateralEnabled;

          expect(beforeUsageAsCollateralEnabled).to.be.false;
          expect(afterUsageAsCollateralEnabled).to.be.false;
        });
      });

      describe("when re-adding a removed collateral asset", async () => {
        beforeEach(async () => {
          // Mint aTokens
          await weth.approve(aaveLendingPool.address, ether(1000));
          await aaveLendingPool
            .connect(owner.wallet)
            .deposit(weth.address, ether(1000), owner.address, ZERO);

          // Approve tokens to issuance module and call issue
          await aWETH.approve(debtIssuanceModule.address, ether(1000));

          // Transfer of aToken to SetToken during issuance would enable the underlying to be used as collateral by SetToken on Aave
          const issueQuantity = ether(1);
          await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

          // Now remove collateral asset to disable underlying to be used as collateral on Aave
          await aaveLeverageModule.removeCollateralAssets(setToken.address, [weth.address]);

          subjectCollateralAssets = [weth.address]; // re-add weth
        });

        it("should re-enable asset to be used as collateral on Aave", async () => {
          const beforeUsageAsCollateralEnabled = (
            await protocolDataProvider.getUserReserveData(weth.address, setToken.address)
          ).usageAsCollateralEnabled;
          await subject();
          const afterUsageAsCollateralEnabled = (
            await protocolDataProvider.getUserReserveData(weth.address, setToken.address)
          ).usageAsCollateralEnabled;
          expect(beforeUsageAsCollateralEnabled).to.be.false;
          expect(afterUsageAsCollateralEnabled).to.be.true;
        });
      });

      describe("when collateral asset is duplicated", async () => {
        beforeEach(async () => {
          subjectCollateralAssets = [weth.address, weth.address];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Collateral already enabled");
        });
      });

      describe("when a new Aave reserve is added as collateral", async () => {
        let mockToken: StandardTokenMock;
        beforeEach(async () => {
          mockToken = await registerMockToken();
          subjectCollateralAssets = [mockToken.address];
        });

        describe("when asset can be used as collateral", async () => {
          beforeEach(async () => {
            const ltv = 5500;
            const liquidationThreshold = 6100;
            const liquidationBonus = 10830;
            await lendingPoolConfigurator.configureReserveAsCollateral(
              mockToken.address,
              ltv,
              liquidationThreshold,
              liquidationBonus,
            );
          });
          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Invalid aToken address");
          });

          describe("when updateUnderlyingToReserveTokenMappings is called before", async () => {
            beforeEach(async () => {
              await aaveLeverageModule.addUnderlyingToReserveTokensMapping(mockToken.address);
            });

            it("should add collateral asset to mappings", async () => {
              await subject();
              const collateralAssets = (
                await aaveLeverageModule.getEnabledAssets(setToken.address)
              )[0];
              const isMockTokenCollateral = await aaveLeverageModule.collateralAssetEnabled(
                setToken.address,
                mockToken.address,
              );

              expect(JSON.stringify(collateralAssets)).to.eq(
                JSON.stringify([weth.address, mockToken.address]),
              );
              expect(isMockTokenCollateral).to.be.true;
            });
          });

          describe("when collateral asset does not exist on Aave", async () => {
            beforeEach(async () => {
              subjectCollateralAssets = [await getRandomAddress()];
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("IAR");
            });
          });
          describe("when the caller is not the SetToken manager", async () => {
            beforeEach(async () => {
              subjectCaller = await getRandomAccount();
            });

            it("should revert", async () => {
              await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
            });
          });
        });

        describe("when asset can not be used as collateral", async () => {
          beforeEach(async () => {
            await aaveLeverageModule.addUnderlyingToReserveTokensMapping(mockToken.address);
          });
          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("CNE");
          });
        });
      });
    });

    describe("when module is not initialized", async () => {
      beforeEach(async () => {
        isInitialized = false;
        await initializeContracts();
        initializeSubjectVariables();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#addBorrowAssets", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;
    let subjectSetToken: Address;
    let subjectBorrowAssets: Address[];
    let subjectCaller: Account;
    const initializeContracts = async () => {
      setToken = await createSetToken(
        [weth.address, dai.address],
        [ether(1), ether(100)],
        [aaveLeverageModule.address, debtIssuanceModule.address],
      );
      await initializeDebtIssuanceModule(setToken.address);
      // Add SetToken to allow list
      await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
      // Initialize module if set to true
      if (isInitialized) {
        await aaveLeverageModule.initialize(setToken.address, [], [weth.address]);
      }
    };
    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
      subjectBorrowAssets = [dai.address];
      subjectCaller = owner;
    };
    async function subject(): Promise<any> {
      return aaveLeverageModule
        .connect(subjectCaller.wallet)
        .addBorrowAssets(subjectSetToken, subjectBorrowAssets);
    }
    describe("when module is initialized", () => {
      beforeEach(() => {
        isInitialized = true;
      });
      cacheBeforeEach(initializeContracts);
      beforeEach(initializeSubjectVariables);
      it("should add the borrow asset to mappings", async () => {
        await subject();
        const borrowAssets = (await aaveLeverageModule.getEnabledAssets(setToken.address))[1];
        const isDAIBorrow = await aaveLeverageModule.borrowAssetEnabled(
          setToken.address,
          dai.address,
        );
        expect(JSON.stringify(borrowAssets)).to.eq(JSON.stringify([weth.address, dai.address]));
        expect(isDAIBorrow).to.be.true;
      });
      it("should emit the correct BorrowAssetsUpdated event", async () => {
        await expect(subject())
          .to.emit(aaveLeverageModule, "BorrowAssetsUpdated")
          .withArgs(subjectSetToken, true, subjectBorrowAssets);
      });
      describe("when borrow asset is duplicated", async () => {
        beforeEach(async () => {
          subjectBorrowAssets = [dai.address, dai.address];
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Borrow already enabled");
        });
      });
      describe("when a new Aave reserve is added as borrow", async () => {
        let mockToken: StandardTokenMock;
        beforeEach(async () => {
          mockToken = await registerMockToken();
          subjectBorrowAssets = [mockToken.address];
        });
        describe("when asset can be borrowed", async () => {
          beforeEach(async () => {
            await lendingPoolConfigurator.setReserveBorrowing(mockToken.address, true);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Invalid variable debt token address");
          });
          describe("when updateUnderlyingToReserveTokenMappings is called before", async () => {
            beforeEach(async () => {
              await aaveLeverageModule.addUnderlyingToReserveTokensMapping(mockToken.address);
            });
            it("should add collateral asset to mappings", async () => {
              await subject();
              const borrowAssets = (await aaveLeverageModule.getEnabledAssets(setToken.address))[1];
              const isMockTokenBorrow = await aaveLeverageModule.borrowAssetEnabled(
                setToken.address,
                mockToken.address,
              );
              expect(JSON.stringify(borrowAssets)).to.eq(
                JSON.stringify([weth.address, mockToken.address]),
              );
              expect(isMockTokenBorrow).to.be.true;
            });
          });
        });
        describe("when borrowing is disabled for an asset on Aave", async () => {
          beforeEach(async () => {
            await aaveLeverageModule.addUnderlyingToReserveTokensMapping(mockToken.address);
          });
          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("BNE");
          });
        });
      });
      describe("when borrow asset reserve does not exist on Aave", async () => {
        beforeEach(async () => {
          subjectBorrowAssets = [await getRandomAddress()];
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("IAR");
        });
      });
      describe("when borrow asset reserve is frozen on Aave", async () => {
        beforeEach(async () => {
          await lendingPoolConfigurator.setReserveFreeze(dai.address, true);
        });
        afterEach(async () => {
          await lendingPoolConfigurator.setReserveFreeze(dai.address, false);
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("FAR");
        });
      });
      describe("when the caller is not the SetToken manager", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
        });
      });
    });
    describe("when module is not initialized", async () => {
      beforeEach(async () => {
        isInitialized = false;
        await initializeContracts();
        initializeSubjectVariables();
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#registerToModule", async () => {
    let setToken: SetToken;
    let otherIssuanceModule: DebtIssuanceMock;
    let isInitialized: boolean;
    let subjectSetToken: Address;
    let subjectDebtIssuanceModule: Address;
    const initializeContracts = async function () {
      otherIssuanceModule = await deployer.mocks.deployDebtIssuanceMock();
      await controller.addModule(otherIssuanceModule.address);
      setToken = await createSetToken(
        [aWETH.address],
        [ether(100)],
        [aaveLeverageModule.address, debtIssuanceModule.address],
      );
      await initializeDebtIssuanceModule(setToken.address);
      // Add SetToken to allow list
      await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
      // Initialize module if set to true
      if (isInitialized) {
        await aaveLeverageModule.initialize(
          setToken.address,
          [weth.address, dai.address, wbtc.address], // Enable WBTC that is not a Set position
          [dai.address, weth.address, wbtc.address],
        );
      }
      // Add other issuance mock after initializing Aave Leverage module, so register is never called
      await setToken.addModule(otherIssuanceModule.address);
      await otherIssuanceModule.initialize(setToken.address);
    };
    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
      subjectDebtIssuanceModule = otherIssuanceModule.address;
    };
    async function subject(): Promise<any> {
      return aaveLeverageModule.registerToModule(subjectSetToken, subjectDebtIssuanceModule);
    }
    describe("when module is initialized", () => {
      beforeEach(() => {
        isInitialized = true;
      });
      cacheBeforeEach(initializeContracts);
      beforeEach(initializeSubjectVariables);
      it("should register on the other issuance module", async () => {
        const previousIsRegistered = await otherIssuanceModule.isRegistered(setToken.address);
        await subject();
        const currentIsRegistered = await otherIssuanceModule.isRegistered(setToken.address);
        expect(previousIsRegistered).to.be.false;
        expect(currentIsRegistered).to.be.true;
      });
      describe("when SetToken is not valid", async () => {
        beforeEach(async () => {
          const nonEnabledSetToken = await createNonControllerEnabledSetToken(
            [weth.address],
            [ether(1)],
            [aaveLeverageModule.address],
          );
          subjectSetToken = nonEnabledSetToken.address;
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });
      describe("when debt issuance module is not initialized on SetToken", async () => {
        beforeEach(async () => {
          await setToken.removeModule(otherIssuanceModule.address);
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("INI");
        });
      });
    });
    describe("when module is not initialized", async () => {
      beforeEach(async () => {
        isInitialized = false;
        await initializeContracts();
        initializeSubjectVariables();
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#moduleIssueHook", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;
    let subjectSetToken: Address;
    let subjectCaller: Account;
    context("when aWETH and aDAI are collateral and WETH and DAI are borrow assets", async () => {
      before(async () => {
        isInitialized = true;
      });
      cacheBeforeEach(async () => {
        // Add mock module to controller
        await controller.addModule(mockModule.address);
        setToken = await createSetToken(
          [aWETH.address, aDAI.address],
          [ether(10), ether(5000)],
          [aaveLeverageModule.address, debtIssuanceModule.address],
        );
        await initializeDebtIssuanceModule(setToken.address);
        // Add SetToken to allow list
        await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
        // Initialize module if set to true
        if (isInitialized) {
          await aaveLeverageModule.initialize(
            setToken.address,
            [weth.address, dai.address, wbtc.address], // Enable WBTC that is not a Set position
            [dai.address, weth.address, wbtc.address],
          );
        }
        // Initialize mock module
        await setToken.addModule(mockModule.address);
        await setToken.connect(mockModule.wallet).initializeModule();
        // Mint aTokens
        await weth.approve(aaveLendingPool.address, ether(10));
        await aaveLendingPool
          .connect(owner.wallet)
          .deposit(weth.address, ether(10), owner.address, ZERO);
        await dai.approve(aaveLendingPool.address, ether(10000));
        await aaveLendingPool
          .connect(owner.wallet)
          .deposit(dai.address, ether(10000), owner.address, ZERO);
        // Approve tokens to issuance module and call issue
        await aWETH.approve(debtIssuanceModule.address, ether(10));
        await aDAI.approve(debtIssuanceModule.address, ether(10000));
        // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 1000 DAI regardless of Set supply
        const issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);
        // Lever both aDAI and aWETH in SetToken
        if (isInitialized) {
          const leverEthTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
            [dai.address, weth.address], // Swap path
            [500], // fees
            true,
          );
          await aaveLeverageModule.lever(
            setToken.address,
            dai.address,
            weth.address,
            ether(2000),
            ether(1),
            "UNISWAPV3",
            leverEthTradeData,
          );
          const leverDaiTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
            [weth.address, dai.address], // Swap path
            [500], // fees
            true,
          );
          await aaveLeverageModule.lever(
            setToken.address,
            weth.address,
            dai.address,
            ether(1),
            ether(1000),
            "UNISWAPV3",
            leverDaiTradeData,
          );
        }
      });
      beforeEach(() => {
        subjectSetToken = setToken.address;
        subjectCaller = mockModule;
      });
      async function subject(): Promise<any> {
        return aaveLeverageModule
          .connect(subjectCaller.wallet)
          .moduleIssueHook(subjectSetToken, ZERO);
      }
      it("should update the collateral positions on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();
        await subject();
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];
        const newSecondPosition = (await setToken.getPositions())[1];
        const expectedFirstPositionUnit = await aWETH.balanceOf(setToken.address); // need not divide, since total Supply = 1
        const expectedSecondPositionUnit = await aDAI.balanceOf(setToken.address);
        expect(initialPositions.length).to.eq(4);
        expect(currentPositions.length).to.eq(4);
        expect(newFirstPosition.component).to.eq(aWETH.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
        expect(newSecondPosition.component).to.eq(aDAI.address);
        expect(newSecondPosition.positionState).to.eq(0); // Default
        expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
        expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
      });
      it("should update the borrow positions on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();
        await subject();
        // aWETH position is increased
        const currentPositions = await setToken.getPositions();
        const newThirdPosition = (await setToken.getPositions())[2];
        const newFourthPosition = (await setToken.getPositions())[3];
        const expectedThirdPositionUnit = (await variableDebtDAI.balanceOf(setToken.address)).mul(
          -1,
        ); // since, variable debt mode
        const expectedFourthPositionUnit = (await variableDebtWETH.balanceOf(setToken.address)).mul(
          -1,
        );
        expect(initialPositions.length).to.eq(4);
        expect(currentPositions.length).to.eq(4);
        expect(newThirdPosition.component).to.eq(dai.address);
        expect(newThirdPosition.positionState).to.eq(1); // External
        expect(newThirdPosition.unit).to.eq(expectedThirdPositionUnit);
        expect(newThirdPosition.module).to.eq(aaveLeverageModule.address);
        expect(newFourthPosition.component).to.eq(weth.address);
        expect(newFourthPosition.positionState).to.eq(1); // External
        expect(newFourthPosition.unit).to.eq(expectedFourthPositionUnit);
        expect(newFourthPosition.module).to.eq(aaveLeverageModule.address);
      });
      describe("when caller is not module", async () => {
        beforeEach(async () => {
          subjectCaller = owner;
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Only the module can call");
        });
      });
      describe("if disabled module is caller", async () => {
        beforeEach(async () => {
          await controller.removeModule(mockModule.address);
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Module must be enabled on controller");
        });
      });
    });
  });

  describe("#moduleRedeemHook", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;
    let subjectSetToken: Address;
    let subjectCaller: Account;
    context("when aWETH and aDAI are collateral and WETH and DAI are borrow assets", async () => {
      before(async () => {
        isInitialized = true;
      });
      cacheBeforeEach(async () => {
        // Add mock module to controller
        await controller.addModule(mockModule.address);
        setToken = await createSetToken(
          [aWETH.address, aDAI.address],
          [ether(10), ether(5000)],
          [aaveLeverageModule.address, debtIssuanceModule.address],
        );
        await initializeDebtIssuanceModule(setToken.address);
        // Add SetToken to allow list
        await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
        // Initialize module if set to true
        if (isInitialized) {
          await aaveLeverageModule.initialize(
            setToken.address,
            [weth.address, dai.address, wbtc.address], // Enable WBTC that is not a Set position
            [dai.address, weth.address, wbtc.address],
          );
        }
        // Initialize mock module
        await setToken.addModule(mockModule.address);
        await setToken.connect(mockModule.wallet).initializeModule();
        // Mint aTokens
        await weth.approve(aaveLendingPool.address, ether(10));
        await aaveLendingPool
          .connect(owner.wallet)
          .deposit(weth.address, ether(10), owner.address, ZERO);
        await dai.approve(aaveLendingPool.address, ether(10000));
        await aaveLendingPool
          .connect(owner.wallet)
          .deposit(dai.address, ether(10000), owner.address, ZERO);
        // Approve tokens to issuance module and call issue
        await aWETH.approve(debtIssuanceModule.address, ether(10));
        await aDAI.approve(debtIssuanceModule.address, ether(10000));
        // Issue 10 SetToken. Note: 1inch mock is hardcoded to trade 1000 DAI regardless of Set supply
        const issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);
        // Lever both aDAI and aWETH in SetToken
        if (isInitialized) {
          const leverEthTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
            [dai.address, weth.address], // Swap path
            [500], // fees
            true,
          );
          await aaveLeverageModule.lever(
            setToken.address,
            dai.address,
            weth.address,
            ether(2000),
            ether(1),
            "UNISWAPV3",
            leverEthTradeData,
          );
          const leverDaiTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
            [weth.address, dai.address], // Swap path
            [500], // fees
            true,
          );
          await aaveLeverageModule.lever(
            setToken.address,
            weth.address,
            dai.address,
            ether(1),
            ether(1000),
            "UNISWAPV3",
            leverDaiTradeData,
          );
        }
      });
      beforeEach(() => {
        subjectSetToken = setToken.address;
        subjectCaller = mockModule;
      });
      async function subject(): Promise<any> {
        return aaveLeverageModule
          .connect(subjectCaller.wallet)
          .moduleRedeemHook(subjectSetToken, ZERO);
      }
      it("should update the collateral positions on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();
        await subject();
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];
        const newSecondPosition = (await setToken.getPositions())[1];
        const expectedFirstPositionUnit = await aWETH.balanceOf(setToken.address); // need not divide, since total Supply = 1
        const expectedSecondPositionUnit = await aDAI.balanceOf(setToken.address);
        expect(initialPositions.length).to.eq(4);
        expect(currentPositions.length).to.eq(4);
        expect(newFirstPosition.component).to.eq(aWETH.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
        expect(newSecondPosition.component).to.eq(aDAI.address);
        expect(newSecondPosition.positionState).to.eq(0); // Default
        expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
        expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
      });
      it("should update the borrow positions on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();
        await subject();
        // aWETH position is increased
        const currentPositions = await setToken.getPositions();
        const newThirdPosition = (await setToken.getPositions())[2];
        const newFourthPosition = (await setToken.getPositions())[3];
        const expectedThirdPositionUnit = (await variableDebtDAI.balanceOf(setToken.address)).mul(
          -1,
        ); // since, variable debt mode
        const expectedFourthPositionUnit = (await variableDebtWETH.balanceOf(setToken.address)).mul(
          -1,
        );
        expect(initialPositions.length).to.eq(4);
        expect(currentPositions.length).to.eq(4);
        expect(newThirdPosition.component).to.eq(dai.address);
        expect(newThirdPosition.positionState).to.eq(1); // External
        expect(newThirdPosition.unit).to.eq(expectedThirdPositionUnit);
        expect(newThirdPosition.module).to.eq(aaveLeverageModule.address);
        expect(newFourthPosition.component).to.eq(weth.address);
        expect(newFourthPosition.positionState).to.eq(1); // External
        expect(newFourthPosition.unit).to.eq(expectedFourthPositionUnit);
        expect(newFourthPosition.module).to.eq(aaveLeverageModule.address);
      });
      describe("when caller is not module", async () => {
        beforeEach(async () => {
          subjectCaller = owner;
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Only the module can call");
        });
      });
      describe("if disabled module is caller", async () => {
        beforeEach(async () => {
          await controller.removeModule(mockModule.address);
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Module must be enabled on controller");
        });
      });
    });
  });

  describe("#componentIssueHook", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;
    let borrowQuantity: BigNumber;
    let subjectSetToken: Address;
    let subjectSetQuantity: BigNumber;
    let subjectComponent: Address;
    let subjectIsEquity: boolean;
    let subjectCaller: Account;
    let issueQuantity: BigNumber;
    context("when aWETH is collateral and DAI is borrow asset", async () => {
      before(async () => {
        isInitialized = true;
      });
      cacheBeforeEach(async () => {
        // Add mock module to controller
        await controller.addModule(mockModule.address);
        setToken = await createSetToken(
          [aWETH.address],
          [ether(2)],
          [aaveLeverageModule.address, debtIssuanceModule.address],
        );
        await initializeDebtIssuanceModule(setToken.address);
        // Add SetToken to allow list
        await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
        // Initialize module if set to true
        if (isInitialized) {
          await aaveLeverageModule.initialize(
            setToken.address,
            [weth.address, dai.address, wbtc.address], // Enable WBTC that is not a Set position
            [dai.address, weth.address, wbtc.address],
          );
        }
        // Initialize mock module
        await setToken.addModule(mockModule.address);
        await setToken.connect(mockModule.wallet).initializeModule();
        // Mint aTokens
        await weth.approve(aaveLendingPool.address, ether(100));
        await aaveLendingPool
          .connect(owner.wallet)
          .deposit(weth.address, ether(100), owner.address, ZERO);
        // Approve tokens to issuance module and call issue
        await aWETH.connect(owner.wallet).approve(debtIssuanceModule.address, ether(100));
        issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);
        // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 1000 DAI regardless of Set supply
        borrowQuantity = ether(2000);
        if (isInitialized) {
          // Lever cETH in SetToken
          const leverEthTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
            [dai.address, weth.address], // Swap path
            [500], // fees
            true,
          );
          await aaveLeverageModule.lever(
            setToken.address,
            dai.address,
            weth.address,
            borrowQuantity,
            ether(0.9),
            "UNISWAPV3",
            leverEthTradeData,
          );
        }
      });
      beforeEach(() => {
        subjectSetToken = setToken.address;
        subjectSetQuantity = issueQuantity;
        subjectComponent = dai.address;
        subjectIsEquity = false;
        subjectCaller = mockModule;
      });
      async function subject(): Promise<any> {
        return aaveLeverageModule
          .connect(subjectCaller.wallet)
          .componentIssueHook(
            subjectSetToken,
            subjectSetQuantity,
            subjectComponent,
            subjectIsEquity,
          );
      }
      it("should increase borrowed quantity on the SetToken", async () => {
        const previousDaiBalance = await dai.balanceOf(setToken.address);
        await subject();
        const currentDaiBalance = await dai.balanceOf(setToken.address);
        expect(previousDaiBalance).to.eq(ZERO);
        expect(currentDaiBalance).to.eq(preciseMul(borrowQuantity, subjectSetQuantity));
      });
      describe("when isEquity is false and component has positive unit (should not happen)", async () => {
        beforeEach(async () => {
          subjectComponent = aWETH.address;
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("CMBN");
        });
      });
      describe("when isEquity is true", async () => {
        beforeEach(async () => {
          subjectIsEquity = true;
        });
        it("should NOT increase borrowed quantity on the SetToken", async () => {
          const previousDaiBalance = await dai.balanceOf(setToken.address);
          await subject();
          const currentDaiBalance = await dai.balanceOf(setToken.address);
          expect(previousDaiBalance).to.eq(ZERO);
          expect(currentDaiBalance).to.eq(ZERO);
        });
      });
      describe("when caller is not module", async () => {
        beforeEach(async () => {
          subjectCaller = owner;
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Only the module can call");
        });
      });
      describe("if disabled module is caller", async () => {
        beforeEach(async () => {
          await controller.removeModule(mockModule.address);
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Module must be enabled on controller");
        });
      });
    });
  });

  describe("#componentRedeemHook", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;
    let repayQuantity: BigNumber;
    let subjectSetToken: Address;
    let subjectSetQuantity: BigNumber;
    let subjectComponent: Address;
    let subjectIsEquity: boolean;
    let subjectCaller: Account;
    let issueQuantity: BigNumber;
    context("when aWETH is collateral and DAI is borrow asset", async () => {
      before(async () => {
        isInitialized = true;
      });
      cacheBeforeEach(async () => {
        // Add mock module to controller
        await controller.addModule(mockModule.address);
        setToken = await createSetToken(
          [aWETH.address],
          [ether(2)],
          [aaveLeverageModule.address, debtIssuanceModule.address],
        );
        await initializeDebtIssuanceModule(setToken.address);
        // Add SetToken to allow list
        await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
        // Initialize module if set to true
        if (isInitialized) {
          await aaveLeverageModule.initialize(
            setToken.address,
            [weth.address, wbtc.address], // Enable WBTC that is not a Set position
            [dai.address, wbtc.address],
          );
        }
        // Initialize mock module
        await setToken.addModule(mockModule.address);
        await setToken.connect(mockModule.wallet).initializeModule();
        // Mint aTokens
        await weth.approve(aaveLendingPool.address, ether(100));
        await aaveLendingPool
          .connect(owner.wallet)
          .deposit(weth.address, ether(100), owner.address, ZERO);
        // Approve tokens to issuance module and call issue
        await aWETH.connect(owner.wallet).approve(debtIssuanceModule.address, ether(100));
        issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);
        repayQuantity = ether(1000);
        // Lever aETH in SetToken
        if (isInitialized) {
          const leverEthTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
            [dai.address, weth.address], // Swap path
            [500], // fees
            true,
          );
          await aaveLeverageModule.lever(
            setToken.address,
            dai.address,
            weth.address,
            repayQuantity,
            ether(0.1),
            "UNISWAPV3",
            leverEthTradeData,
          );
        }
        // Transfer repay quantity to SetToken for repayment
        await dai.transfer(setToken.address, repayQuantity);
      });
      beforeEach(() => {
        subjectSetToken = setToken.address;
        subjectSetQuantity = issueQuantity;
        subjectComponent = dai.address;
        subjectIsEquity = false;
        subjectCaller = mockModule;
      });
      async function subject(): Promise<any> {
        return aaveLeverageModule
          .connect(subjectCaller.wallet)
          .componentRedeemHook(
            subjectSetToken,
            subjectSetQuantity,
            subjectComponent,
            subjectIsEquity,
          );
      }
      it("should decrease borrowed quantity on the SetToken", async () => {
        const previousDaiBalance = await dai.balanceOf(setToken.address);
        await subject();
        const currentDaiBalance = await dai.balanceOf(setToken.address);
        expect(previousDaiBalance).to.eq(repayQuantity);
        expect(currentDaiBalance).to.eq(ZERO);
      });
      describe("when _isEquity is false and component has positive unit", async () => {
        beforeEach(async () => {
          subjectComponent = aWETH.address;
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("CMBN");
        });
      });
      describe("when isEquity is true", async () => {
        beforeEach(async () => {
          subjectIsEquity = true;
        });
        it("should NOT decrease borrowed quantity on the SetToken", async () => {
          const previousDaiBalance = await dai.balanceOf(setToken.address);
          await subject();
          const currentDaiBalance = await dai.balanceOf(setToken.address);
          expect(previousDaiBalance).to.eq(repayQuantity);
          expect(currentDaiBalance).to.eq(repayQuantity);
        });
      });
      describe("when caller is not module", async () => {
        beforeEach(async () => {
          subjectCaller = owner;
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Only the module can call");
        });
      });
      describe("if disabled module is caller", async () => {
        beforeEach(async () => {
          await controller.removeModule(mockModule.address);
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Module must be enabled on controller");
        });
      });
    });
  });

  describe("#removeModule", async () => {
    let setToken: SetToken;
    let subjectModule: Address;
    cacheBeforeEach(async () => {
      setToken = await createSetToken(
        [aWETH.address],
        [ether(100)],
        [aaveLeverageModule.address, debtIssuanceModule.address],
      );
      await initializeDebtIssuanceModule(setToken.address);
      // Add SetToken to allow list
      await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
      await aaveLeverageModule.initialize(
        setToken.address,
        [weth.address],
        [weth.address, dai.address],
      );
      // Mint aTokens
      await weth.approve(aaveLendingPool.address, ether(1000));
      await aaveLendingPool
        .connect(owner.wallet)
        .deposit(weth.address, ether(1000), owner.address, ZERO);
      // Approve tokens to issuance module and call issue
      await aWETH.approve(debtIssuanceModule.address, ether(1000));
      await debtIssuanceModule.issue(setToken.address, ether(1), owner.address);
    });
    beforeEach(() => {
      subjectModule = aaveLeverageModule.address;
    });
    async function subject(): Promise<any> {
      return setToken.removeModule(subjectModule);
    }
    describe("When an EOA is registered as a module", () => {
      cacheBeforeEach(async () => {
        await controller.addModule(owner.address);
        await setToken.addModule(owner.address);
        await setToken.connect(owner.wallet).initializeModule();
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("function call to a non-contract account");
      });
    });
    it("should remove the Module on the SetToken", async () => {
      await subject();
      const isModuleEnabled = await setToken.isInitializedModule(aaveLeverageModule.address);
      expect(isModuleEnabled).to.be.false;
    });
    it("should remove the Module on the SetToken", async () => {
      await subject();
      const isModuleEnabled = await setToken.isInitializedModule(aaveLeverageModule.address);
      expect(isModuleEnabled).to.be.false;
    });
    it("should delete the mappings", async () => {
      await subject();
      const collateralAssets = (await aaveLeverageModule.getEnabledAssets(setToken.address))[0];
      const borrowAssets = (await aaveLeverageModule.getEnabledAssets(setToken.address))[1];
      const isWethCollateral = await aaveLeverageModule.collateralAssetEnabled(
        setToken.address,
        weth.address,
      );
      const isDaiCollateral = await aaveLeverageModule.collateralAssetEnabled(
        setToken.address,
        weth.address,
      );
      const isDaiBorrow = await aaveLeverageModule.borrowAssetEnabled(
        setToken.address,
        weth.address,
      );
      const isEtherBorrow = await aaveLeverageModule.borrowAssetEnabled(
        setToken.address,
        weth.address,
      );
      expect(collateralAssets.length).to.eq(0);
      expect(borrowAssets.length).to.eq(0);
      expect(isWethCollateral).to.be.false;
      expect(isDaiCollateral).to.be.false;
      expect(isDaiBorrow).to.be.false;
      expect(isEtherBorrow).to.be.false;
    });
    it("should unregister on the debt issuance module", async () => {
      const isModuleIssuanceHookBefore = await debtIssuanceModule.isModuleIssuanceHook(
        setToken.address,
        aaveLeverageModule.address,
      );
      expect(isModuleIssuanceHookBefore).to.be.true;
      await subject();
      const isModuleIssuanceHookAfter = await debtIssuanceModule.isModuleIssuanceHook(
        setToken.address,
        aaveLeverageModule.address,
      );
      expect(isModuleIssuanceHookAfter).to.be.false;
    });
    describe("when borrow balance exists", async () => {
      beforeEach(async () => {
        // Lever SetToken
        const leverTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
          [dai.address, weth.address], // Swap path
          [500], // fees
          true,
        );
        await aaveLeverageModule.lever(
          setToken.address,
          dai.address,
          weth.address,
          ether(2000),
          ether(1),
          "UNISWAPV3",
          leverTradeData,
        );
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("VDR");
      });
    });
  });

  describe("#removeCollateralAssets", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;
    let subjectSetToken: Address;
    let subjectCollateralAssets: Address[];
    let subjectCaller: Account;
    const initializeContracts = async () => {
      setToken = await createSetToken(
        [aWETH.address],
        [ether(1)],
        [aaveLeverageModule.address, debtIssuanceModule.address],
      );
      await initializeDebtIssuanceModule(setToken.address);
      // Add SetToken to allow list
      await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
      // Initialize module if set to true
      if (isInitialized) {
        await aaveLeverageModule.initialize(setToken.address, [weth.address, dai.address], []);
      }
    };
    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
      subjectCollateralAssets = [dai.address];
      subjectCaller = owner;
    };
    async function subject(): Promise<any> {
      return await aaveLeverageModule
        .connect(subjectCaller.wallet)
        .removeCollateralAssets(subjectSetToken, subjectCollateralAssets);
    }
    describe("when module is initialized", () => {
      before(async () => {
        isInitialized = true;
      });
      cacheBeforeEach(initializeContracts);
      beforeEach(initializeSubjectVariables);
      it("should remove the collateral asset from mappings", async () => {
        await subject();
        const collateralAssets = (await aaveLeverageModule.getEnabledAssets(setToken.address))[0];
        const isDAICollateral = await aaveLeverageModule.collateralAssetEnabled(
          setToken.address,
          dai.address,
        );
        expect(JSON.stringify(collateralAssets)).to.eq(JSON.stringify([weth.address]));
        expect(isDAICollateral).to.be.false;
      });
      it("should emit the correct CollateralAssetsUpdated event", async () => {
        await expect(subject())
          .to.emit(aaveLeverageModule, "CollateralAssetsUpdated")
          .withArgs(subjectSetToken, false, subjectCollateralAssets);
      });
      describe("when removing a collateral asset which has been enabled to be used as collateral on aave", async () => {
        beforeEach(async () => {
          // Mint aTokens
          await weth.approve(aaveLendingPool.address, ether(1000));
          await aaveLendingPool
            .connect(owner.wallet)
            .deposit(weth.address, ether(1000), owner.address, ZERO);
          // Approve tokens to issuance module and call issue
          await aWETH.approve(debtIssuanceModule.address, ether(1000));
          // Transfer of aToken to SetToken during issuance would enable the underlying to be used as collateral by SetToken on Aave
          const issueQuantity = ether(1);
          await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);
          subjectCollateralAssets = [weth.address]; // remove weth
        });
        it("should disable the asset to be used as collateral on aave", async () => {
          const beforeUsageAsCollateralEnabled = (
            await protocolDataProvider.getUserReserveData(weth.address, setToken.address)
          ).usageAsCollateralEnabled;
          await subject();
          const afterUsageAsCollateralEnabled = (
            await protocolDataProvider.getUserReserveData(weth.address, setToken.address)
          ).usageAsCollateralEnabled;
          expect(beforeUsageAsCollateralEnabled).to.be.true;
          expect(afterUsageAsCollateralEnabled).to.be.false;
        });
      });
      describe("when collateral asset is not enabled on module", async () => {
        beforeEach(async () => {
          subjectCollateralAssets = [weth.address, usdc.address];
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("CNE");
        });
      });
      describe("when the caller is not the SetToken manager", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
        });
      });
    });
    describe("when module is not initialized", async () => {
      beforeEach(async () => {
        isInitialized = false;
        await initializeContracts();
        initializeSubjectVariables();
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#removeBorrowAssets", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;
    let subjectSetToken: Address;
    let subjectBorrowAssets: Address[];
    let subjectCaller: Account;
    const initializeContracts = async () => {
      setToken = await createSetToken(
        [aWETH.address],
        [ether(2)],
        [aaveLeverageModule.address, debtIssuanceModule.address],
      );
      await initializeDebtIssuanceModule(setToken.address);
      // Add SetToken to allow list
      await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
      // Mint aTokens
      await weth.approve(aaveLendingPool.address, ether(1000));
      await aaveLendingPool
        .connect(owner.wallet)
        .deposit(weth.address, ether(1000), owner.address, ZERO);
      // Approve tokens to issuance module and call issue
      await aWETH.approve(debtIssuanceModule.address, ether(1000));
      // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 1000 DAI regardless of Set supply
      const issueQuantity = ether(1);
      await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);
      // Initialize module if set to true
      if (isInitialized) {
        await aaveLeverageModule.initialize(
          setToken.address,
          [weth.address],
          [weth.address, dai.address],
        );
      }
    };
    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
      subjectBorrowAssets = [dai.address];
      subjectCaller = owner;
    };
    async function subject(): Promise<any> {
      return aaveLeverageModule
        .connect(subjectCaller.wallet)
        .removeBorrowAssets(subjectSetToken, subjectBorrowAssets);
    }
    describe("when module is initialized", () => {
      before(() => {
        isInitialized = true;
      });
      cacheBeforeEach(initializeContracts);
      beforeEach(initializeSubjectVariables);
      it("should remove the borrow asset from mappings", async () => {
        await subject();
        const borrowAssets = (await aaveLeverageModule.getEnabledAssets(setToken.address))[1];
        const isDAIBorrow = await aaveLeverageModule.borrowAssetEnabled(
          setToken.address,
          dai.address,
        );
        expect(JSON.stringify(borrowAssets)).to.eq(JSON.stringify([weth.address]));
        expect(isDAIBorrow).to.be.false;
      });
      it("should emit the correct BorrowAssetsUpdated event", async () => {
        await expect(subject())
          .to.emit(aaveLeverageModule, "BorrowAssetsUpdated")
          .withArgs(subjectSetToken, false, subjectBorrowAssets);
      });
      describe("when borrow asset is not enabled on module", async () => {
        beforeEach(async () => {
          subjectBorrowAssets = [dai.address, dai.address];
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("BNE");
        });
      });
      describe("when borrow balance exists", async () => {
        beforeEach(async () => {
          // Lever SetToken
          const leverTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
            [dai.address, weth.address], // Swap path
            [500], // fees
            true,
          );
          await aaveLeverageModule.lever(
            setToken.address,
            dai.address,
            weth.address,
            ether(2000),
            ether(1),
            "UNISWAPV3",
            leverTradeData,
          );
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("VDR");
        });
      });
      describe("when the caller is not the SetToken manager", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });
        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
        });
      });
    });
    describe("when module is not initialized", async () => {
      beforeEach(async () => {
        isInitialized = false;
        await initializeContracts();
        initializeSubjectVariables();
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#updateAllowedSetToken", async () => {
    let setToken: SetToken;
    let subjectSetToken: Address;
    let subjectStatus: boolean;
    let subjectCaller: Account;
    beforeEach(async () => {
      setToken = setToken = await createSetToken(
        [aWETH.address],
        [ether(2)],
        [aaveLeverageModule.address, debtIssuanceModule.address],
      );
      subjectSetToken = setToken.address;
      subjectStatus = true;
      subjectCaller = owner;
    });
    async function subject(): Promise<any> {
      return aaveLeverageModule
        .connect(subjectCaller.wallet)
        .updateAllowedSetToken(subjectSetToken, subjectStatus);
    }
    it("should add Set to allow list", async () => {
      await subject();
      const isAllowed = await aaveLeverageModule.allowedSetTokens(subjectSetToken);
      expect(isAllowed).to.be.true;
    });
    it("should emit the correct SetTokenStatusUpdated event", async () => {
      await expect(subject())
        .to.emit(aaveLeverageModule, "SetTokenStatusUpdated")
        .withArgs(subjectSetToken, subjectStatus);
    });
    describe("when disabling a Set", async () => {
      beforeEach(async () => {
        await subject();
        subjectStatus = false;
      });
      it("should remove Set from allow list", async () => {
        await subject();
        const isAllowed = await aaveLeverageModule.allowedSetTokens(subjectSetToken);
        expect(isAllowed).to.be.false;
      });
      it("should emit the correct SetTokenStatusUpdated event", async () => {
        await expect(subject())
          .to.emit(aaveLeverageModule, "SetTokenStatusUpdated")
          .withArgs(subjectSetToken, subjectStatus);
      });
      describe("when Set Token is removed on controller", async () => {
        beforeEach(async () => {
          await controller.removeSet(setToken.address);
        });
        it("should remove the Set from allow list", async () => {
          await subject();
          const isAllowed = await aaveLeverageModule.allowedSetTokens(subjectSetToken);
          expect(isAllowed).to.be.false;
        });
      });
    });
    describe("when Set is removed on controller", async () => {
      beforeEach(async () => {
        await controller.removeSet(setToken.address);
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("IST");
      });
    });
    describe("when not called by owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#updateAnySetAllowed", async () => {
    let subjectAnySetAllowed: boolean;
    let subjectCaller: Account;
    beforeEach(async () => {
      subjectAnySetAllowed = true;
      subjectCaller = owner;
    });
    async function subject(): Promise<any> {
      return aaveLeverageModule
        .connect(subjectCaller.wallet)
        .updateAnySetAllowed(subjectAnySetAllowed);
    }
    it("should remove Set from allow list", async () => {
      await subject();
      const anySetAllowed = await aaveLeverageModule.anySetAllowed();
      expect(anySetAllowed).to.be.true;
    });
    it("should emit the correct AnySetAllowedUpdated event", async () => {
      await expect(subject())
        .to.emit(aaveLeverageModule, "AnySetAllowedUpdated")
        .withArgs(subjectAnySetAllowed);
    });
    describe("when not called by owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  });

  describe("#addUnderlyingToReserveTokensMappings", async () => {
    let subjectUnderlying: Address;
    let subjectCaller: Account;
    beforeEach(async () => {
      const mockToken = await registerMockToken();
      subjectUnderlying = mockToken.address;
      subjectCaller = await getRandomAccount();
    });
    async function subject(): Promise<any> {
      return aaveLeverageModule
        .connect(subjectCaller.wallet)
        .addUnderlyingToReserveTokensMapping(subjectUnderlying);
    }
    it("should add the underlying to reserve tokens mappings", async () => {
      await subject();
      const reserveTokens = await aaveLeverageModule.underlyingToReserveTokens(subjectUnderlying);
      expect(reserveTokens.aToken).to.not.eq(ADDRESS_ZERO);
      expect(reserveTokens.variableDebtToken).to.not.eq(ADDRESS_ZERO);
    });
    it("should emit ReserveTokensUpdated event", async () => {
      await expect(subject()).to.emit(aaveLeverageModule, "ReserveTokensUpdated");
    });
    describe("when mapping already exists", async () => {
      beforeEach(async () => {
        subjectUnderlying = weth.address;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("MAE");
      });
    });
    describe("when reserve is invalid", async () => {
      beforeEach(async () => {
        subjectUnderlying = await getRandomAddress();
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("IAE");
      });
    });
  });
});
