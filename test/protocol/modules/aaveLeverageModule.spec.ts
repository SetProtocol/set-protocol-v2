import "module-alias/register";
import Web3 from "web3";
import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  AaveV2,
  AaveLeverageModule,
  DebtIssuanceMock,
  OneInchExchangeAdapter,
  OneInchExchangeMock,
  SetToken,
  UniswapV2ExchangeAdapterV2
} from "@utils/contracts";
import {
  AaveV2AToken,
  AaveV2VariableDebtToken
} from "@utils/contracts/aaveV2";
import DeployHelper from "@utils/deploys";
import {
  ether,
  preciseDiv,
  preciseMul
} from "@utils/index";
import {
  cacheBeforeEach,
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  getAaveV2Fixture,
  getRandomAccount,
  getRandomAddress,
  getUniswapFixture
} from "@utils/test/index";
import { AaveV2Fixture, SystemFixture, UniswapFixture } from "@utils/fixtures";
import { BigNumber, ContractTransaction } from "ethers";
import { ADDRESS_ZERO, ZERO, EMPTY_BYTES, MAX_UINT_256 } from "@utils/constants";
import { ReserveTokens } from "@utils/fixtures/aaveV2Fixture";

const expect = getWaffleExpect();
const web3 = new Web3();

describe("AaveLeverageModule", () => {
  let owner: Account;
  let mockModule: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;
  let aaveSetup: AaveV2Fixture;

  let aaveV2Library: AaveV2;
  let aaveLeverageModule: AaveLeverageModule;
  let debtIssuanceMock: DebtIssuanceMock;

  let aWETH: AaveV2AToken;
  let aDAI: AaveV2AToken;
  let variableDebtWETH: AaveV2VariableDebtToken;
  let variableDebtDAI: AaveV2VariableDebtToken;

  let oneInchFunctionSignature: Bytes;
  let oneInchExchangeMockToWeth: OneInchExchangeMock;
  let oneInchExchangeMockFromWeth: OneInchExchangeMock;
  let oneInchExchangeMockWithSlippage: OneInchExchangeMock;
  let oneInchExchangeMockOneWei: OneInchExchangeMock;

  let oneInchExchangeAdapterToWeth: OneInchExchangeAdapter;
  let oneInchExchangeAdapterFromWeth: OneInchExchangeAdapter;

  cacheBeforeEach(async () => {
    [
      owner,
      mockModule,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setup = getSystemFixture(owner.address);
    await setup.initialize();

    aaveSetup = getAaveV2Fixture(owner.address);
    await aaveSetup.initialize(setup.weth.address, setup.dai.address);

    // Create a WBTC reserve
    await aaveSetup.createAndEnableReserve(
      setup.wbtc.address, "WBTC", BigNumber.from(18),
      BigNumber.from(8000),   // base LTV: 80%
      BigNumber.from(8250),   // liquidation threshold: 82.5%
      BigNumber.from(10500),  // liquidation bonus: 105.00%
      BigNumber.from(1000),   // reserve factor: 10%
      true,                   // enable borrowing on reserve
      true                    // enable stable debts
    );

    // Create liquidity
    const ape = await getRandomAccount();   // The wallet which aped in first and added initial liquidity
    await setup.weth.transfer(ape.address, ether(50));
    await setup.weth.connect(ape.wallet).approve(aaveSetup.lendingPool.address, ether(50));
    await aaveSetup.lendingPool.connect(ape.wallet).deposit(
      setup.weth.address,
      ether(50),
      ape.address,
      ZERO
    );
    await setup.dai.transfer(ape.address, ether(50000));
    await setup.dai.connect(ape.wallet).approve(aaveSetup.lendingPool.address, ether(50000));
    await aaveSetup.lendingPool.connect(ape.wallet).deposit(
      setup.dai.address,
      ether(50000),
      ape.address,
      ZERO
    );

    aWETH = aaveSetup.wethReserveTokens.aToken;
    variableDebtWETH = aaveSetup.wethReserveTokens.variableDebtToken;

    aDAI = aaveSetup.daiReserveTokens.aToken;
    variableDebtDAI = aaveSetup.daiReserveTokens.variableDebtToken;

    debtIssuanceMock = await deployer.mocks.deployDebtIssuanceMock();
    await setup.controller.addModule(debtIssuanceMock.address);

    aaveV2Library = await deployer.libraries.deployAaveV2();
    aaveLeverageModule = await deployer.modules.deployAaveLeverageModule(
      setup.controller.address,
      aaveSetup.lendingPoolAddressesProvider.address,
      "contracts/protocol/integration/lib/AaveV2.sol:AaveV2",
      aaveV2Library.address,
    );
    await setup.controller.addModule(aaveLeverageModule.address);

    // Deploy 1inch mock contracts

    // 1inch function signature
    oneInchFunctionSignature = web3.eth.abi.encodeFunctionSignature(
      "swap(address,address,uint256,uint256,uint256,address,address[],bytes,uint256[],uint256[])"
    );

    // Mock OneInch exchange that allows for fixed exchange amounts. So we need to setup separate exchange adapters
    oneInchExchangeMockToWeth = await deployer.mocks.deployOneInchExchangeMock(
      setup.dai.address,
      setup.weth.address,
      ether(1000), // 1000 DAI
      ether(1), // Trades for 1 WETH
    );
    oneInchExchangeAdapterToWeth = await deployer.adapters.deployOneInchExchangeAdapter(
      oneInchExchangeMockToWeth.address,
      oneInchExchangeMockToWeth.address,
      oneInchFunctionSignature
    );

    await setup.integrationRegistry.addIntegration(
      aaveLeverageModule.address,
      "ONEINCHTOWETH",
      oneInchExchangeAdapterToWeth.address
    );

    oneInchExchangeMockFromWeth = await deployer.mocks.deployOneInchExchangeMock(
      setup.weth.address,
      setup.dai.address,
      ether(1), // 1 WETH
      ether(1000), // Trades for 1000 DAI
    );
    oneInchExchangeAdapterFromWeth = await deployer.adapters.deployOneInchExchangeAdapter(
      oneInchExchangeMockFromWeth.address,
      oneInchExchangeMockFromWeth.address,
      oneInchFunctionSignature
    );

    await setup.integrationRegistry.addIntegration(
      aaveLeverageModule.address,
      "ONEINCHFROMWETH",
      oneInchExchangeAdapterFromWeth.address
    );

    // Setup Mock 1inch exchange that does not return sufficient units to satisfy slippage requirement
    oneInchExchangeMockWithSlippage = await deployer.mocks.deployOneInchExchangeMock(
      setup.dai.address,
      setup.weth.address,
      ether(1000), // 1000 DAI
      ether(0.9), // Trades for 0.9 WETH
    );
    const oneInchExchangeAdapterWithSlippage = await deployer.adapters.deployOneInchExchangeAdapter(
      oneInchExchangeMockWithSlippage.address,
      oneInchExchangeMockWithSlippage.address,
      oneInchFunctionSignature
    );

    await setup.integrationRegistry.addIntegration(
      aaveLeverageModule.address,
      "ONEINCHSLIPPAGE",
      oneInchExchangeAdapterWithSlippage.address
    );

    // Setup Mock 1inch exchange that takes in 1 wei of DAI
    oneInchExchangeMockOneWei = await deployer.mocks.deployOneInchExchangeMock(
      setup.dai.address,
      setup.weth.address,
      BigNumber.from(1), // 1 wei of DAI
      ether(1), // Trades for 1 WETH
    );
    const oneInchExchangeAdapterOneWei = await deployer.adapters.deployOneInchExchangeAdapter(
      oneInchExchangeMockOneWei.address,
      oneInchExchangeMockOneWei.address,
      oneInchFunctionSignature
    );

    await setup.integrationRegistry.addIntegration(
      aaveLeverageModule.address,
      "ONEINCHWEI",
      oneInchExchangeAdapterOneWei.address
    );

    // Add debt issuance address to integration
    await setup.integrationRegistry.addIntegration(
      aaveLeverageModule.address,
      "DefaultIssuanceModule",
      debtIssuanceMock.address
    );
  });

  describe("#constructor", async () => {
    let subjectController: Address;
    let subjectLendingPoolAddressesProvider: Address;

    beforeEach(async () => {
      subjectController = setup.controller.address;
      subjectLendingPoolAddressesProvider = aaveSetup.lendingPoolAddressesProvider.address;
    });

    async function subject(): Promise<AaveLeverageModule> {
      return deployer.modules.deployAaveLeverageModule(
        subjectController,
        subjectLendingPoolAddressesProvider,
        "contracts/protocol/integration/lib/AaveV2.sol:AaveV2",
        aaveV2Library.address
      );
    }

    it("should set the correct controller", async () => {
      const aaveLeverageModule = await subject();

      const controller = await aaveLeverageModule.controller();
      expect(controller).to.eq(subjectController);
    });

    it("should set the correct Aave contracts", async () => {
      const aaveLeverageModule = await subject();

      const lendingPoolAddressesProvider = await aaveLeverageModule.lendingPoolAddressesProvider();
      const protocolDataProvider = await aaveLeverageModule.protocolDataProvider();

      expect(lendingPoolAddressesProvider).to.eq(aaveSetup.lendingPoolAddressesProvider.address);
      expect(protocolDataProvider).to.eq(aaveSetup.protocolDataProvider.address);
    });

    it("should set the correct underlying to reserve tokens mappings", async () => {
      const aaveLeverageModule = await subject();

      const wethReserveTokens = await aaveLeverageModule.underlyingToReserveTokens(setup.weth.address);
      const daiReserveTokens = await aaveLeverageModule.underlyingToReserveTokens(setup.dai.address);

      expect(wethReserveTokens.aToken).to.eq(aWETH.address);
      expect(wethReserveTokens.variableDebtToken).to.eq(aaveSetup.wethReserveTokens.variableDebtToken.address);
      expect(daiReserveTokens.aToken).to.eq(aaveSetup.daiReserveTokens.aToken.address);
      expect(daiReserveTokens.variableDebtToken).to.eq(aaveSetup.daiReserveTokens.variableDebtToken.address);
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
      setToken = await setup.createSetToken(
        [setup.weth.address, setup.dai.address],
        [ether(1), ether(100)],
        [aaveLeverageModule.address, debtIssuanceMock.address]
      );
      await debtIssuanceMock.initialize(setToken.address);

      if (isAllowListed) {
        // Add SetToken to allow list
        await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
      }
    };

    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
      subjectCollateralAssets = [setup.weth.address, setup.dai.address];
      subjectBorrowAssets = [setup.dai.address, setup.weth.address];
      subjectCaller = owner;
    };

    async function subject(): Promise<any> {
      return aaveLeverageModule.connect(subjectCaller.wallet).initialize(
        subjectSetToken,
        subjectCollateralAssets,
        subjectBorrowAssets
      );
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

        const isWethCollateral = await aaveLeverageModule.collateralAssetEnabled(setToken.address, setup.weth.address);
        const isDaiCollateral = await aaveLeverageModule.collateralAssetEnabled(setToken.address, setup.dai.address);
        const isDaiBorrow = await aaveLeverageModule.borrowAssetEnabled(setToken.address, setup.dai.address);
        const isWethBorrow = await aaveLeverageModule.borrowAssetEnabled(setToken.address, setup.weth.address);

        expect(JSON.stringify(collateralAssets)).to.eq(JSON.stringify(subjectCollateralAssets));
        expect(JSON.stringify(borrowAssets)).to.eq(JSON.stringify(subjectBorrowAssets));
        expect(isWethCollateral).to.be.true;
        expect(isDaiCollateral).to.be.true;
        expect(isDaiBorrow).to.be.true;
        expect(isWethBorrow).to.be.true;
      });

      it("should register on the debt issuance module", async () => {
        await subject();
        const isRegistered = await debtIssuanceMock.isRegistered(setToken.address);
        expect(isRegistered).to.be.true;
      });

      describe("when debt issuance module is not added to integration registry", async () => {
        beforeEach(async () => {
          await setup.integrationRegistry.removeIntegration(aaveLeverageModule.address, "DefaultIssuanceModule");
        });

        afterEach(async () => {
          // Add debt issuance address to integration
          await setup.integrationRegistry.addIntegration(
            aaveLeverageModule.address,
            "DefaultIssuanceModule",
            debtIssuanceMock.address
          );
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be valid adapter");
        });
      });

      describe("when debt issuance module is not initialized on SetToken", async () => {
        beforeEach(async () => {
          await setToken.removeModule(debtIssuanceMock.address);
        });

        afterEach(async () => {
          await setToken.addModule(debtIssuanceMock.address);
          await debtIssuanceMock.initialize(setToken.address);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Issuance not initialized");
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
          await setup.controller.addModule(newModule);

          const aaveLeverageModuleNotPendingSetToken = await setup.createSetToken(
            [setup.weth.address],
            [ether(1)],
            [newModule]
          );

          subjectSetToken = aaveLeverageModuleNotPendingSetToken.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be pending initialization");
        });
      });

      describe("when the SetToken is not enabled on the controller", async () => {
        beforeEach(async () => {
          const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
            [setup.weth.address],
            [ether(1)],
            [aaveLeverageModule.address]
          );

          subjectSetToken = nonEnabledSetToken.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be controller-enabled SetToken");
        });
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
          await expect(subject()).to.be.revertedWith("Not allowed SetToken");
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

    context("when aWETH is collateral asset and borrow positions is 0", async () => {
      const initializeContracts = async () => {
        setToken = await setup.createSetToken(
          [aWETH.address],
          [ether(2)],
          [aaveLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
        );
        await debtIssuanceMock.initialize(setToken.address);
        // Add SetToken to allow list
        await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
        // Initialize module if set to true
        if (isInitialized) {
          await aaveLeverageModule.initialize(
            setToken.address,
            [setup.weth.address, setup.dai.address],
            [setup.dai.address, setup.weth.address]
          );
        }
        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

        // Add Set token as token sender / recipient
        oneInchExchangeMockToWeth = oneInchExchangeMockToWeth.connect(owner.wallet);
        await oneInchExchangeMockToWeth.addSetTokenAddress(setToken.address);

        // Fund One Inch exchange with destinationToken WETH
        await setup.weth.transfer(oneInchExchangeMockToWeth.address, ether(10));

        // Mint aTokens
        await setup.weth.approve(aaveSetup.lendingPool.address, ether(1000));
        await aaveSetup.lendingPool.connect(owner.wallet).deposit(setup.weth.address, ether(1000), owner.address, ZERO);
        // await setup.dai.approve(aaveSetup.lendingPool.address, ether(10000));
        // await aaveSetup.lendingPool.connect(owner.wallet).deposit(setup.dai.address, ether(10000), owner.address, ZERO);

        // Approve tokens to issuance module and call issue
        await aWETH.approve(setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 1000 DAI regardless of Set supply
        const issueQuantity = ether(1);
        destinationTokenQuantity = ether(1);
        await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);
      };

      const initializeSubjectVariables = () => {
        subjectSetToken = setToken.address;
        subjectBorrowAsset = setup.dai.address;
        subjectCollateralAsset = setup.weth.address;
        subjectBorrowQuantity = ether(1000);
        subjectMinCollateralQuantity = destinationTokenQuantity;
        subjectTradeAdapterName = "ONEINCHTOWETH";
        subjectTradeData = oneInchExchangeMockToWeth.interface.encodeFunctionData("swap", [
          setup.dai.address, // Send token
          setup.weth.address, // Receive token
          subjectBorrowQuantity, // Send quantity
          subjectMinCollateralQuantity, // Min receive quantity
          ZERO,
          ADDRESS_ZERO,
          [ADDRESS_ZERO],
          EMPTY_BYTES,
          [ZERO],
          [ZERO],
        ]);
        subjectCaller = owner;
      };

      async function subject(): Promise<any> {
        return aaveLeverageModule.connect(subjectCaller.wallet).lever(
          subjectSetToken,
          subjectBorrowAsset,
          subjectCollateralAsset,
          subjectBorrowQuantity,
          subjectMinCollateralQuantity,
          subjectTradeAdapterName,
          subjectTradeData
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

          // cWETH position is increased
          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];

          const expectedFirstPositionUnit = initialPositions[0].unit.add(destinationTokenQuantity);

          expect(initialPositions.length).to.eq(1);
          expect(currentPositions.length).to.eq(2);   // added a new borrow position
          expect(newFirstPosition.component).to.eq(aWETH.address);
          expect(newFirstPosition.positionState).to.eq(0); // Default
          expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
          expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
        });

        it("should update the borrow position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // cEther position is increased
          const currentPositions = await setToken.getPositions();
          const newSecondPosition = (await setToken.getPositions())[1];

          const expectedSecondPositionUnit = (await variableDebtDAI.balanceOf(setToken.address)).mul(-1);

          expect(initialPositions.length).to.eq(1);
          expect(currentPositions.length).to.eq(2);
          expect(newSecondPosition.component).to.eq(setup.dai.address);
          expect(newSecondPosition.positionState).to.eq(1); // External
          expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
          expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
        });

        it("should transfer the correct components to the exchange", async () => {
          const oldSourceTokenBalance = await setup.dai.balanceOf(oneInchExchangeMockToWeth.address);

          await subject();
          const totalSourceQuantity = subjectBorrowQuantity;
          const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
          const newSourceTokenBalance = await setup.dai.balanceOf(oneInchExchangeMockToWeth.address);
          expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
        });

        it("should transfer the correct components from the exchange", async () => {
          const oldDestinationTokenBalance = await setup.weth.balanceOf(oneInchExchangeMockToWeth.address);

          await subject();
          const totalDestinationQuantity = destinationTokenQuantity;
          const expectedDestinationTokenBalance = oldDestinationTokenBalance.sub(totalDestinationQuantity);
          const newDestinationTokenBalance = await setup.weth.balanceOf(oneInchExchangeMockToWeth.address);
          expect(newDestinationTokenBalance).to.eq(expectedDestinationTokenBalance);
        });

        describe("when the leverage position has been liquidated", async () => {
          let ethSeized: BigNumber;

          cacheBeforeEach(async () => {
            // Lever up
            await aaveLeverageModule.connect(subjectCaller.wallet).lever(
              subjectSetToken,
              subjectBorrowAsset,
              subjectCollateralAsset,
              subjectBorrowQuantity,
              subjectMinCollateralQuantity,
              subjectTradeAdapterName,
              subjectTradeData
            );

            // ETH decreases to $250
            const liquidationDaiPriceInEth = ether(0.004);    // 1/250 = 0.004
            await aaveSetup.setAssetPriceInOracle(setup.dai.address, liquidationDaiPriceInEth);

            // Seize 1 ETH + liquidation bonus by repaying debt of 250 DAI
            ethSeized = ether(1);
            const debtToCover = ether(250);
            await setup.dai.approve(aaveSetup.lendingPool.address, ether(250));

            await aaveSetup.lendingPool.connect(owner.wallet).liquidationCall(
              setup.weth.address,
              setup.dai.address,
              setToken.address,
              debtToCover,
              true
            );

            // ETH increases to $1250 to allow more borrow
            await aaveSetup.setAssetPriceInOracle(setup.dai.address, ether(0.0008));  // 1/1250 = .0008

            subjectBorrowQuantity = ether(1000);
          });

          it("should transfer the correct components to the exchange", async () => {
            const oldSourceTokenBalance = await setup.dai.balanceOf(oneInchExchangeMockToWeth.address);

            await subject();
            const totalSourceQuantity = subjectBorrowQuantity;
            const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
            const newSourceTokenBalance = await setup.dai.balanceOf(oneInchExchangeMockToWeth.address);
            expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
          });

          it("should update the collateral position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // aWETH position is increased
            const currentPositions = await setToken.getPositions();
            const newFirstPosition = (await setToken.getPositions())[0];

            // Get expected aTokens minted
            const newUnits = destinationTokenQuantity;
            const aaveLiquidationBonus = (await aaveSetup.protocolDataProvider.getReserveConfigurationData(setup.weth.address)).liquidationBonus;
            const liquidatedEth = preciseDiv(preciseMul(ethSeized, aaveLiquidationBonus), BigNumber.from(10000));   // ethSeized * 105%

            const expectedPostLiquidationUnit = initialPositions[0].unit.sub(liquidatedEth).add(newUnits);

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newFirstPosition.component).to.eq(aWETH.address);
            expect(newFirstPosition.positionState).to.eq(0); // Default
            expect(newFirstPosition.unit).to.eq(expectedPostLiquidationUnit);
            expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
          });

          it("should update the borrow position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // cEther position is increased
            const currentPositions = await setToken.getPositions();
            const newSecondPosition = (await setToken.getPositions())[1];

            const expectedSecondPositionUnit = (await variableDebtDAI.balanceOf(setToken.address)).mul(-1);

            expect(initialPositions.length).to.eq(2);
            expect(currentPositions.length).to.eq(2);
            expect(newSecondPosition.component).to.eq(setup.dai.address);
            expect(newSecondPosition.positionState).to.eq(1); // External
            expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
            expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
          });
        });

        describe("when there is a protocol fee charged", async () => {
          let feePercentage: BigNumber;

          cacheBeforeEach(async () => {
            feePercentage = ether(0.05);
            setup.controller = setup.controller.connect(owner.wallet);
            await setup.controller.addFee(
              aaveLeverageModule.address,
              ZERO, // Fee type on trade function denoted as 0
              feePercentage // Set fee to 5 bps
            );
          });

          it("should transfer the correct components to the exchange", async () => {
            const oldSourceTokenBalance = await setup.dai.balanceOf(oneInchExchangeMockToWeth.address);

            await subject();
            const totalSourceQuantity = subjectBorrowQuantity;
            const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
            const newSourceTokenBalance = await setup.dai.balanceOf(oneInchExchangeMockToWeth.address);
            expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
          });

          it("should transfer the correct protocol fee to the protocol", async () => {
            const feeRecipient = await setup.controller.feeRecipient();
            const oldFeeRecipientBalance = await setup.weth.balanceOf(feeRecipient);

            await subject();
            const expectedFeeRecipientBalance = oldFeeRecipientBalance.add(preciseMul(feePercentage, destinationTokenQuantity));
            const newFeeRecipientBalance = await setup.weth.balanceOf(feeRecipient);
            expect(newFeeRecipientBalance).to.eq(expectedFeeRecipientBalance);
          });

          it("should update the collateral position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // cEther position is increased
            const currentPositions = await setToken.getPositions();
            const newFirstPosition = (await setToken.getPositions())[0];

            // Get expected cTokens minted
            const unitProtocolFee = feePercentage.mul(destinationTokenQuantity).div(ether(1));
            const newUnits = destinationTokenQuantity.sub(unitProtocolFee);
            const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);

            expect(initialPositions.length).to.eq(1);
            expect(currentPositions.length).to.eq(2);
            expect(newFirstPosition.component).to.eq(aWETH.address);
            expect(newFirstPosition.positionState).to.eq(0); // Default
            expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
            expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
          });

          it("should update the borrow position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // cEther position is increased
            const currentPositions = await setToken.getPositions();
            const newSecondPosition = (await setToken.getPositions())[1];

            const expectedSecondPositionUnit = (await variableDebtDAI.balanceOf(setToken.address)).mul(-1);

            expect(initialPositions.length).to.eq(1);
            expect(currentPositions.length).to.eq(2);
            expect(newSecondPosition.component).to.eq(setup.dai.address);
            expect(newSecondPosition.positionState).to.eq(1); // External
            expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
            expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
          });

          it("should emit the correct LeverageIncreased event", async () => {
            const totalBorrowQuantity = subjectBorrowQuantity;
            const totalCollateralQuantity = destinationTokenQuantity;
            const totalProtocolFee = feePercentage.mul(totalCollateralQuantity).div(ether(1));

            await expect(subject()).to.emit(aaveLeverageModule, "LeverageIncreased").withArgs(
              setToken.address,
              subjectBorrowAsset,
              subjectCollateralAsset,
              oneInchExchangeAdapterToWeth.address,
              totalBorrowQuantity,
              totalCollateralQuantity.sub(totalProtocolFee),
              totalProtocolFee
            );
          });
        });

        describe("when slippage is greater than allowed", async () => {
          cacheBeforeEach(async () => {
            // Add Set token as token sender / recipient
            oneInchExchangeMockWithSlippage = oneInchExchangeMockWithSlippage.connect(owner.wallet);
            await oneInchExchangeMockWithSlippage.addSetTokenAddress(setToken.address);

            // Fund One Inch exchange with destinationToken WETH
            await setup.weth.transfer(oneInchExchangeMockWithSlippage.address, ether(10));

            // Set to other mock exchange adapter with slippage
            subjectTradeAdapterName = "ONEINCHSLIPPAGE";
            subjectTradeData = oneInchExchangeMockWithSlippage.interface.encodeFunctionData("swap", [
              setup.dai.address, // Send token
              setup.weth.address, // Receive token
              subjectBorrowQuantity, // Send quantity
              subjectMinCollateralQuantity, // Min receive quantity
              ZERO,
              ADDRESS_ZERO,
              [ADDRESS_ZERO],
              EMPTY_BYTES,
              [ZERO],
              [ZERO],
            ]);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Slippage too high");
          });
        });

        describe("when the exchange is not valid", async () => {
          beforeEach(async () => {
            subjectTradeAdapterName = "UNISWAP";
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be valid adapter");
          });
        });

        describe("when collateral asset is not enabled", async () => {
          beforeEach(async () => {
            subjectCollateralAsset = setup.wbtc.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Collateral not enabled");
          });
        });

        describe("when borrow asset is not enabled", async () => {
          beforeEach(async () => {
            subjectBorrowAsset = await getRandomAddress();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Borrow not enabled");
          });
        });

        describe("when borrow asset is same as collateral asset", async () => {
          beforeEach(async () => {
            subjectBorrowAsset = setup.weth.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Collateral and borrow asset must be different");
          });
        });

        describe("when quantity of token to sell is 0", async () => {
          beforeEach(async () => {
            subjectBorrowQuantity = ZERO;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Quantity is 0");
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
            const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
              [setup.weth.address],
              [ether(1)],
              [aaveLeverageModule.address],
              owner.address
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
        setToken = await setup.createSetToken(
          [aWETH.address, setup.dai.address],
          [ether(2), ether(1)],
          [aaveLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
        );
        await debtIssuanceMock.initialize(setToken.address);
        // Add SetToken to allow list
        await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
        // Initialize module if set to true
        if (isInitialized) {
          await aaveLeverageModule.initialize(
            setToken.address,
            [setup.weth.address, setup.dai.address],
            [setup.dai.address, setup.weth.address]
          );
        }
        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

        // Add Set token as token sender / recipient
        oneInchExchangeMockToWeth = oneInchExchangeMockToWeth.connect(owner.wallet);
        await oneInchExchangeMockToWeth.addSetTokenAddress(setToken.address);

        // Fund One Inch exchange with destinationToken WETH
        await setup.weth.transfer(oneInchExchangeMockToWeth.address, ether(10));

        // Mint aTokens
        await setup.weth.approve(aaveSetup.lendingPool.address, ether(1000));
        await aaveSetup.lendingPool.connect(owner.wallet).deposit(setup.weth.address, ether(1000), owner.address, ZERO);
        await setup.dai.approve(aaveSetup.lendingPool.address, ether(10000));
        await aaveSetup.lendingPool.connect(owner.wallet).deposit(setup.dai.address, ether(10000), owner.address, ZERO);

        // Approve tokens to issuance module and call issue
        await aWETH.approve(setup.issuanceModule.address, ether(1000));
        await aDAI.approve(setup.issuanceModule.address, ether(10000));

        // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 1000 DAI regardless of Set supply
        const issueQuantity = ether(1);
        destinationTokenQuantity = ether(1);
        await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);
      });

      beforeEach(() => {
        subjectSetToken = setToken.address;
        subjectBorrowAsset = setup.dai.address;
        subjectCollateralAsset = setup.weth.address;
        subjectBorrowQuantity = ether(1000);
        subjectMinCollateralQuantity = destinationTokenQuantity;
        subjectTradeAdapterName = "ONEINCHTOWETH";
        subjectTradeData = oneInchExchangeMockToWeth.interface.encodeFunctionData("swap", [
          setup.dai.address, // Send token
          setup.weth.address, // Receive token
          subjectBorrowQuantity, // Send quantity
          subjectMinCollateralQuantity, // Min receive quantity
          ZERO,
          ADDRESS_ZERO,
          [ADDRESS_ZERO],
          EMPTY_BYTES,
          [ZERO],
          [ZERO],
        ]);
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return aaveLeverageModule.connect(subjectCaller.wallet).lever(
          subjectSetToken,
          subjectBorrowAsset,
          subjectCollateralAsset,
          subjectBorrowQuantity,
          subjectMinCollateralQuantity,
          subjectTradeAdapterName,
          subjectTradeData
        );
      }

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];
        const newSecondPosition = (await setToken.getPositions())[1];

        // Get expected aTokens minted
        const newUnits = destinationTokenQuantity;
        const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(3);
        expect(newFirstPosition.component).to.eq(aWETH.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);

        expect(newSecondPosition.component).to.eq(setup.dai.address);
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
        expect(newThridPosition.component).to.eq(setup.dai.address);
        expect(newThridPosition.positionState).to.eq(1); // External
        expect(newThridPosition.unit).to.eq(expectedPositionUnit);
        expect(newThridPosition.module).to.eq(aaveLeverageModule.address);
      });
    });
  });

  describe("#delever", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;
    let destinationTokenQuantity: BigNumber;

    let subjectSetToken: Address;
    let subjectCollateralAsset: Address;
    let subjectRepayAsset: Address;
    let subjectRedeemQuantity: BigNumber;
    let subjectMinRepayQuantity: BigNumber;
    let subjectTradeAdapterName: string;
    let subjectTradeData: Bytes;
    let subjectCaller: Account;

    const initializeContracts = async () => {
      setToken = await setup.createSetToken(
        [aWETH.address],
        [ether(2)],
        [aaveLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
      );
      await debtIssuanceMock.initialize(setToken.address);
      // Add SetToken to allow list
      await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
      // Initialize module if set to true
      if (isInitialized) {
        await aaveLeverageModule.initialize(
          setToken.address,
          [setup.weth.address, setup.dai.address],
          [setup.dai.address, setup.weth.address]
        );
      }
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

      // Add Set token as token sender / recipient
      oneInchExchangeMockToWeth = oneInchExchangeMockToWeth.connect(owner.wallet);
      await oneInchExchangeMockToWeth.addSetTokenAddress(setToken.address);

      // Fund One Inch exchange with destinationToken WETH
      await setup.weth.transfer(oneInchExchangeMockToWeth.address, ether(10));

      // Add Set token as token sender / recipient
      oneInchExchangeMockFromWeth = oneInchExchangeMockFromWeth.connect(owner.wallet);
      await oneInchExchangeMockFromWeth.addSetTokenAddress(setToken.address);

      // Fund One Inch exchange with destinationToken DAI
      await setup.weth.transfer(oneInchExchangeAdapterToWeth.address, ether(100));
      await setup.dai.transfer(oneInchExchangeMockFromWeth.address, ether(10000));

      // Mint aTokens
      await setup.weth.approve(aaveSetup.lendingPool.address, ether(1000));
      await aaveSetup.lendingPool.connect(owner.wallet).deposit(setup.weth.address, ether(1000), owner.address, ZERO);

      // Approve tokens to issuance module and call issue
      await aWETH.approve(setup.issuanceModule.address, ether(1000));

      // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 1000 DAI regardless of Set supply
      const issueQuantity = ether(1);
      await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

      // Lever SetToken
      if (isInitialized) {
        const leverTradeData = oneInchExchangeMockToWeth.interface.encodeFunctionData("swap", [
          setup.dai.address, // Send token
          setup.weth.address, // Receive token
          ether(1000), // Send quantity
          ether(1), // Min receive quantity
          ZERO,
          ADDRESS_ZERO,
          [ADDRESS_ZERO],
          EMPTY_BYTES,
          [ZERO],
          [ZERO],
        ]);

        await aaveLeverageModule.lever(
          setToken.address,
          setup.dai.address,
          setup.weth.address,
          ether(1000),
          ether(1),
          "ONEINCHTOWETH",
          leverTradeData
        );
      }

      destinationTokenQuantity = ether(1000);
    };

    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
      subjectCollateralAsset = setup.weth.address;
      subjectRepayAsset = setup.dai.address;
      subjectRedeemQuantity = ether(1);
      subjectMinRepayQuantity = destinationTokenQuantity;
      subjectTradeAdapterName = "ONEINCHFROMWETH";
      subjectTradeData = oneInchExchangeMockFromWeth.interface.encodeFunctionData("swap", [
        setup.weth.address, // Send token
        setup.dai.address, // Receive token
        subjectRedeemQuantity, // Send quantity
        subjectMinRepayQuantity, // Min receive quantity
        ZERO,
        ADDRESS_ZERO,
        [ADDRESS_ZERO],
        EMPTY_BYTES,
        [ZERO],
        [ZERO],
      ]);
      subjectCaller = owner;
    };

    async function subject(): Promise<any> {
      return aaveLeverageModule.connect(subjectCaller.wallet).delever(
        subjectSetToken,
        subjectCollateralAsset,
        subjectRepayAsset,
        subjectRedeemQuantity,
        subjectMinRepayQuantity,
        subjectTradeAdapterName,
        subjectTradeData
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
        expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // Most of cDai position is repaid
        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];
        const expectedSecondPositionUnit = (await variableDebtDAI.balanceOf(setToken.address)).mul(-1);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component).to.eq(setup.dai.address);
        expect(newSecondPosition.positionState).to.eq(1); // External
        expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
        expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
      });

      it("should transfer the correct components to the exchange", async () => {
        const oldSourceTokenBalance = await setup.weth.balanceOf(oneInchExchangeMockFromWeth.address);

        await subject();
        const totalSourceQuantity = subjectRedeemQuantity;
        const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
        const newSourceTokenBalance = await setup.weth.balanceOf(oneInchExchangeMockFromWeth.address);
        expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
      });

      it("should transfer the correct components from the exchange", async () => {
        const oldDestinationTokenBalance = await setup.dai.balanceOf(oneInchExchangeMockFromWeth.address);

        await subject();
        const totalDestinationQuantity = destinationTokenQuantity;
        const expectedDestinationTokenBalance = oldDestinationTokenBalance.sub(totalDestinationQuantity);
        const newDestinationTokenBalance = await setup.dai.balanceOf(oneInchExchangeMockFromWeth.address);
        expect(newDestinationTokenBalance).to.eq(expectedDestinationTokenBalance);
      });

      describe("when there is a protocol fee charged", async () => {
        let feePercentage: BigNumber;

        cacheBeforeEach(async () => {
          feePercentage = ether(0.05);
          setup.controller = setup.controller.connect(owner.wallet);
          await setup.controller.addFee(
            aaveLeverageModule.address,
            ZERO, // Fee type on trade function denoted as 0
            feePercentage // Set fee to 5 bps
          );
        });

        it("should transfer the correct components to the exchange", async () => {
          const oldSourceTokenBalance = await setup.weth.balanceOf(oneInchExchangeMockFromWeth.address);

          await subject();
          const totalSourceQuantity = subjectRedeemQuantity;
          const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
          const newSourceTokenBalance = await setup.weth.balanceOf(oneInchExchangeMockFromWeth.address);
          expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
        });

        it("should transfer the correct protocol fee to the protocol", async () => {
          const feeRecipient = await setup.controller.feeRecipient();
          const oldFeeRecipientBalance = await setup.dai.balanceOf(feeRecipient);

          await subject();
          const expectedFeeRecipientBalance = oldFeeRecipientBalance.add(preciseMul(feePercentage, destinationTokenQuantity));
          const newFeeRecipientBalance = await setup.dai.balanceOf(feeRecipient);
          expect(newFeeRecipientBalance).to.eq(expectedFeeRecipientBalance);
        });

        it("should update the collateral position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];

          const newUnits = subjectRedeemQuantity;
          const expectedFirstPositionUnit = initialPositions[0].unit.sub(newUnits);

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newFirstPosition.component).to.eq(aWETH.address);
          expect(newFirstPosition.positionState).to.eq(0); // Default
          expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
          expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
        });

        it("should update the borrow position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          const currentPositions = await setToken.getPositions();
          const newSecondPosition = (await setToken.getPositions())[1];

          const expectedSecondPositionUnit = (await variableDebtDAI.balanceOf(setToken.address)).mul(-1);

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newSecondPosition.component).to.eq(setup.dai.address);
          expect(newSecondPosition.positionState).to.eq(1); // External
          expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
          expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
        });

        it("should emit the correct LeverageDecreased event", async () => {
          const totalCollateralQuantity = subjectRedeemQuantity;
          const totalRepayQuantity = destinationTokenQuantity;
          const totalProtocolFee = feePercentage.mul(totalRepayQuantity).div(ether(1));

          await expect(subject()).to.emit(aaveLeverageModule, "LeverageDecreased").withArgs(
            setToken.address,
            subjectCollateralAsset,
            subjectRepayAsset,
            oneInchExchangeAdapterFromWeth.address,
            totalCollateralQuantity,
            totalRepayQuantity.sub(totalProtocolFee),
            totalProtocolFee
          );
        });
      });

      describe("when used to delever to zero", async () => {

        beforeEach(async () => {
          subjectMinRepayQuantity = ether(1001);
          await oneInchExchangeMockFromWeth.updateReceiveAmount(subjectMinRepayQuantity);

          subjectTradeData = oneInchExchangeMockFromWeth.interface.encodeFunctionData("swap", [
            setup.weth.address, // Send token
            setup.dai.address, // Receive token
            subjectRedeemQuantity, // Send quantity
            subjectMinRepayQuantity, // Min receive quantity
            ZERO,
            ADDRESS_ZERO,
            [ADDRESS_ZERO],
            EMPTY_BYTES,
            [ZERO],
            [ZERO],
          ]);
        });

        it("should transfer the correct components to the exchange", async () => {
          const oldSourceTokenBalance = await setup.weth.balanceOf(oneInchExchangeMockFromWeth.address);

          await subject();
          const totalSourceQuantity = subjectRedeemQuantity;
          const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
          const newSourceTokenBalance = await setup.weth.balanceOf(oneInchExchangeMockFromWeth.address);
          expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
        });

        it("should update the collateral position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];

          const newUnits = subjectRedeemQuantity;
          const expectedFirstPositionUnit = initialPositions[0].unit.sub(newUnits);

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newFirstPosition.component).to.eq(aWETH.address);
          expect(newFirstPosition.positionState).to.eq(0); // Default
          expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
          expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
        });

        it("should update the borrow position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          const currentPositions = await setToken.getPositions();
          const newSecondPosition = (await setToken.getPositions())[1];

          const expectedSecondPositionUnit = await setup.dai.balanceOf(setToken.address);

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newSecondPosition.component).to.eq(setup.dai.address);
          expect(newSecondPosition.positionState).to.eq(0); // Default since we traded for more Dai than outstannding debt
          expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
          expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
        });

        it("should emit the correct LeverageDecreased event", async () => {
          const totalCollateralQuantity = subjectRedeemQuantity;
          const totalRepayQuantity = subjectMinRepayQuantity;

          await expect(subject()).to.emit(aaveLeverageModule, "LeverageDecreased").withArgs(
            setToken.address,
            subjectCollateralAsset,
            subjectRepayAsset,
            oneInchExchangeAdapterFromWeth.address,
            totalCollateralQuantity,
            totalRepayQuantity,
            ZERO
          );
        });
      });

      describe("when the exchange is not valid", async () => {
        beforeEach(async () => {
          subjectTradeAdapterName = "UNISWAP";
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be valid adapter");
        });
      });

      describe("when quantity of token to sell is 0", async () => {
        beforeEach(async () => {
          subjectRedeemQuantity = ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Quantity is 0");
        });
      });

      describe("when borrow / repay asset is not enabled", async () => {
        beforeEach(async () => {
          subjectRepayAsset = setup.wbtc.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Borrow not enabled");
        });
      });

      describe("when collateral asset is not enabled", async () => {
        beforeEach(async () => {
          subjectCollateralAsset = await getRandomAddress();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Collateral not enabled");
        });
      });

      describe("when borrow asset is same as collateral asset", async () => {
        beforeEach(async () => {
          subjectRepayAsset = setup.weth.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Collateral and borrow asset must be different");
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
          const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
            [setup.weth.address],
            [ether(1)],
            [aaveLeverageModule.address],
            owner.address
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

    let uniswapExchangeAdapter: UniswapV2ExchangeAdapterV2;
    let uniswapSetup: UniswapFixture;
    let subjectSetToken: Address;
    let subjectCollateralAsset: Address;
    let subjectRepayAsset: Address;
    let subjectRedeemQuantity: BigNumber;
    let subjectTradeAdapterName: string;
    let subjectTradeData: Bytes;
    let subjectCaller: Account;

    const initializeContracts = async () => {
      setToken = await setup.createSetToken(
        [aWETH.address],
        [ether(10)],
        [aaveLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
      );
      await debtIssuanceMock.initialize(setToken.address);
      // Add SetToken to allow list
      await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
      // Initialize module if set to true
      if (isInitialized) {
        await aaveLeverageModule.initialize(
          setToken.address,
          [setup.weth.address, setup.dai.address],
          [setup.dai.address, setup.weth.address]
        );
      }
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

      // Add Set token as token sender / recipient
      oneInchExchangeMockToWeth = oneInchExchangeMockToWeth.connect(owner.wallet);
      await oneInchExchangeMockToWeth.addSetTokenAddress(setToken.address);

      // Fund One Inch exchange with destinationToken WETH
      await setup.weth.transfer(oneInchExchangeMockToWeth.address, ether(1));

      // Setup uniswap
      uniswapSetup = getUniswapFixture(owner.address);
      await uniswapSetup.initialize(owner, setup.weth.address, setup.wbtc.address, setup.dai.address);
      uniswapExchangeAdapter = await deployer.adapters.deployUniswapV2ExchangeAdapterV2(uniswapSetup.router.address);

      // Add integration
      await setup.integrationRegistry.addIntegration(
        aaveLeverageModule.address,
        "UNISWAP",
        uniswapExchangeAdapter.address
      );

      // Add liquidity
      await setup.weth.approve(uniswapSetup.router.address, ether(500));
      await setup.dai.approve(uniswapSetup.router.address, ether(500000));
      await uniswapSetup.router.addLiquidity(
        setup.weth.address,
        setup.dai.address,
        ether(500),
        ether(500000),
        ether(499),
        ether(499000),
        owner.address,
        MAX_UINT_256
      );

      // Mint aTokens
      await setup.weth.approve(aaveSetup.lendingPool.address, ether(10));
      await aaveSetup.lendingPool.connect(owner.wallet).deposit(setup.weth.address, ether(10), owner.address, ZERO);

      // Approve tokens to issuance module and call issue
      await aWETH.approve(setup.issuanceModule.address, ether(10));

      // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 1000 DAI regardless of Set supply
      const issueQuantity = ether(1);
      await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

      // Lever SetToken
      if (isInitialized) {
        const leverTradeData = oneInchExchangeMockToWeth.interface.encodeFunctionData("swap", [
          setup.dai.address, // Send token
          setup.weth.address, // Receive token
          ether(1000), // Send quantity
          ether(1), // Min receive quantity
          ZERO,
          ADDRESS_ZERO,
          [ADDRESS_ZERO],
          EMPTY_BYTES,
          [ZERO],
          [ZERO],
        ]);

        await aaveLeverageModule.lever(
          setToken.address,
          setup.dai.address,
          setup.weth.address,
          ether(1000),
          ether(1),
          "ONEINCHTOWETH",
          leverTradeData
        );
      }
    };

    const initializeSubjectVariables = async () => {
      subjectSetToken = setToken.address;
      subjectCollateralAsset = setup.weth.address;
      subjectRepayAsset = setup.dai.address;
      subjectRedeemQuantity = ether(2);
      subjectTradeAdapterName = "UNISWAP";
      subjectCaller = owner;
      subjectTradeData = await uniswapExchangeAdapter.generateDataParam(
        setup.weth.address,
        setup.dai.address,
        true   // fixed_input
      );
    };

    async function subject(): Promise<ContractTransaction> {
      return await aaveLeverageModule.connect(subjectCaller.wallet).deleverToZeroBorrowBalance(
        subjectSetToken,
        subjectCollateralAsset,
        subjectRepayAsset,
        subjectRedeemQuantity,
        subjectTradeAdapterName,
        subjectTradeData
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
        expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should wipe the debt on Aave", async () => {
        await subject();

        const borrowDebt = await variableDebtDAI.balanceOf(setToken.address);

        expect(borrowDebt).to.eq(ZERO);
      });

      it("should remove external positions on the borrow asset", async () => {
        await subject();

        const borrowAssetExternalModules = await setToken.getExternalPositionModules(setup.dai.address);
        const borrowExternalUnit = await setToken.getExternalPositionRealUnit(
          setup.dai.address,
          aaveLeverageModule.address
        );
        const isPositionModule = await setToken.isExternalPositionModule(
          setup.dai.address,
          aaveLeverageModule.address
        );

        expect(borrowAssetExternalModules.length).to.eq(0);
        expect(borrowExternalUnit).to.eq(ZERO);
        expect(isPositionModule).to.eq(false);
      });

      it("should update the borrow asset equity on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        const [, repayAssetAmountOut] = await uniswapSetup.router.getAmountsOut(
          subjectRedeemQuantity,
          [setup.weth.address, setup.dai.address]
        );

        const tx = await subject();

        // Fetch total repay amount
        const res = await tx.wait();
        const levDecreasedEvent = res.events?.find(value => {
          return value.event == "LeverageDecreased";
        });
        const totalRepayAmount: BigNumber = levDecreasedEvent?.args?.[5];

        const expectedSecondPositionUnit = repayAssetAmountOut.sub(totalRepayAmount);

        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component).to.eq(setup.dai.address);
        expect(newSecondPosition.positionState).to.eq(0); // Default
        expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
        expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should transfer the correct components to the exchange", async () => {
        const oldSourceTokenBalance = await setup.weth.balanceOf(uniswapSetup.wethDaiPool.address);

        await subject();
        const totalSourceQuantity = subjectRedeemQuantity;
        const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
        const newSourceTokenBalance = await setup.weth.balanceOf(uniswapSetup.wethDaiPool.address);
        expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
      });

      it("should transfer the correct components from the exchange", async () => {
        const [, repayAssetAmountOut] = await uniswapSetup.router.getAmountsOut(
          subjectRedeemQuantity,
          [setup.weth.address, setup.dai.address]
        );
        const oldDestinationTokenBalance = await setup.dai.balanceOf(uniswapSetup.wethDaiPool.address);

        await subject();
        const totalDestinationQuantity = repayAssetAmountOut;
        const expectedDestinationTokenBalance = oldDestinationTokenBalance.sub(totalDestinationQuantity);
        const newDestinationTokenBalance = await setup.dai.balanceOf(uniswapSetup.wethDaiPool.address);
        expect(newDestinationTokenBalance).to.eq(expectedDestinationTokenBalance);
      });

      describe("when the exchange is not valid", async () => {
        beforeEach(async () => {
          subjectTradeAdapterName = "UNISWAPV3";
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be valid adapter");
        });
      });

      describe("when borrow / repay asset is not enabled", async () => {
        beforeEach(async () => {
          subjectRepayAsset = setup.wbtc.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Borrow not enabled");
        });
      });

      describe("when borrow balance is 0", async () => {
        beforeEach(async () => {
          await aaveLeverageModule.connect(owner.wallet).addBorrowAssets(setToken.address, [setup.wbtc.address]);

          subjectRepayAsset = setup.wbtc.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Borrow balance is zero");
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
          const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
            [setup.weth.address],
            [ether(1)],
            [aaveLeverageModule.address],
            owner.address
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
        setToken = await setup.createSetToken(
          [aWETH.address, aDAI.address],
          [ether(2), ether(1000)],
          [aaveLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
        );
        await debtIssuanceMock.initialize(setToken.address);
        // Add SetToken to allow list
        await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);

        // Initialize module if set to true
        if (isInitialized) {
          await aaveLeverageModule.initialize(
            setToken.address,
            [setup.weth.address, setup.dai.address, setup.wbtc.address],  // Enable WBTC that is not a Set position
            [setup.dai.address, setup.weth.address, setup.wbtc.address]
          );
        }
        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

        // Add Set token as token sender / recipient
        await oneInchExchangeMockToWeth.addSetTokenAddress(setToken.address);
        await oneInchExchangeMockFromWeth.addSetTokenAddress(setToken.address);

        // Fund One Inch exchange with destinationToken WETH and DAI
        await setup.weth.transfer(oneInchExchangeMockToWeth.address, ether(10));
        await setup.dai.transfer(oneInchExchangeMockFromWeth.address, ether(10000));

        // Mint aTokens
        await setup.weth.approve(aaveSetup.lendingPool.address, ether(1000));
        await aaveSetup.lendingPool.connect(owner.wallet).deposit(setup.weth.address, ether(1000), owner.address, ZERO);
        await setup.dai.approve(aaveSetup.lendingPool.address, ether(10000));
        await aaveSetup.lendingPool.connect(owner.wallet).deposit(setup.dai.address, ether(10000), owner.address, ZERO);

        // Approve tokens to issuance module and call issue
        await aWETH.approve(setup.issuanceModule.address, ether(1000));
        await aDAI.approve(setup.issuanceModule.address, ether(10000));

        // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 1000 DAI regardless of Set supply
        const issueQuantity = ether(1);
        await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        if (isInitialized) {
          // Leverage aWETH in SetToken
          const leverEthTradeData = oneInchExchangeMockToWeth.interface.encodeFunctionData("swap", [
            setup.dai.address, // Send token
            setup.weth.address, // Receive token
            ether(1000), // Send quantity
            ether(1), // Min receive quantity
            ZERO,
            ADDRESS_ZERO,
            [ADDRESS_ZERO],
            EMPTY_BYTES,
            [ZERO],
            [ZERO],
          ]);

          await aaveLeverageModule.lever(
            setToken.address,
            setup.dai.address,
            setup.weth.address,
            ether(1000),
            ether(1),
            "ONEINCHTOWETH",
            leverEthTradeData
          );

          // Leverage DAI in SetToken
          const leverDaiTradeData = oneInchExchangeMockToWeth.interface.encodeFunctionData("swap", [
            setup.weth.address, // Send token
            setup.dai.address, // Receive token
            ether(1), // Send quantity
            ether(1000), // Min receive quantity
            ZERO,
            ADDRESS_ZERO,
            [ADDRESS_ZERO],
            EMPTY_BYTES,
            [ZERO],
            [ZERO],
          ]);

          await aaveLeverageModule.lever(
            setToken.address,
            setup.weth.address,
            setup.dai.address,
            ether(1),
            ether(1000),
            "ONEINCHFROMWETH",
            leverDaiTradeData
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

          const expectedFirstPositionUnit = await aWETH.balanceOf(setToken.address);  // need not divide as total supply is 1.
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

          const expectedThirdPositionUnit = (await variableDebtDAI.balanceOf(setToken.address)).mul(-1);
          const expectedFourthPositionUnit = (await variableDebtWETH.balanceOf(setToken.address)).mul(-1);

          expect(initialPositions.length).to.eq(4);
          expect(currentPositions.length).to.eq(4);
          expect(newThirdPosition.component).to.eq(setup.dai.address);
          expect(newThirdPosition.positionState).to.eq(1); // External
          expect(newThirdPosition.unit).to.eq(expectedThirdPositionUnit);
          expect(newThirdPosition.module).to.eq(aaveLeverageModule.address);

          expect(newFourthPosition.component).to.eq(setup.weth.address);
          expect(newFourthPosition.positionState).to.eq(1); // External
          expect(newFourthPosition.unit).to.eq(expectedFourthPositionUnit);
          expect(newFourthPosition.module).to.eq(aaveLeverageModule.address);
        });

        describe("when leverage position has been liquidated", async () => {
          let liquidationRepayQuantity: BigNumber;

          cacheBeforeEach(async () => {
            // Leverage aWETH again
            const leverEthTradeData = oneInchExchangeMockToWeth.interface.encodeFunctionData("swap", [
              setup.dai.address, // Send token
              setup.weth.address, // Receive token
              ether(1000), // Send quantity
              ether(1), // Min receive quantity
              ZERO,
              ADDRESS_ZERO,
              [ADDRESS_ZERO],
              EMPTY_BYTES,
              [ZERO],
              [ZERO],
            ]);

            await aaveLeverageModule.lever(
              setToken.address,
              setup.dai.address,
              setup.weth.address,
              ether(1000),
              ether(1),
              "ONEINCHTOWETH",
              leverEthTradeData
            );
          });

          beforeEach(async () => {
            // ETH decreases to $100
            const liquidationDaiPriceInEth = ether(0.01);    // 1/100 = 0.01
            await aaveSetup.setAssetPriceInOracle(setup.dai.address, liquidationDaiPriceInEth);

            // Seize 1 ETH + 5% liquidation bonus by repaying debt of 100 DAI
            liquidationRepayQuantity = ether(100);
            await setup.dai.approve(aaveSetup.lendingPool.address, ether(100));

            await aaveSetup.lendingPool.connect(owner.wallet).liquidationCall(
              setup.weth.address,
              setup.dai.address,
              setToken.address,
              liquidationRepayQuantity,
              true
            );
          });

          it("should update the collateral positions on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            const currentPositions = await setToken.getPositions();
            const newFirstPosition = (await setToken.getPositions())[0];
            const newSecondPosition = (await setToken.getPositions())[1];

            // const aaveLiquidationBonus = (await aaveSetup.protocolDataProvider.getReserveConfigurationData(setup.weth.address)).liquidationBonus;
            // const totalTokensSezied = preciseDiv(preciseMul(ether(1), aaveLiquidationBonus), BigNumber.from(10000));   // ethSeized * 105%
            // const expectedFirstPositionUnit = initialPositions[0].unit.sub(totalTokensSezied);   // off by 1 wei, due to interest accrual
            const expectedFirstPositionUnit = await aWETH.balanceOf(setToken.address);

            expect(initialPositions.length).to.eq(4);
            expect(currentPositions.length).to.eq(4);

            // aWETH position decreases
            expect(newFirstPosition.component).to.eq(aWETH.address);
            expect(newFirstPosition.positionState).to.eq(0); // Default
            expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
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

            const expectedThirdPositionUnit = (await variableDebtDAI.balanceOf(setToken.address)).mul(-1);
            const expectedFourthPositionUnit = (await variableDebtWETH.balanceOf(setToken.address)).mul(-1);

            expect(initialPositions.length).to.eq(4);
            expect(currentPositions.length).to.eq(4);

            expect(newThirdPosition.component).to.eq(setup.dai.address);
            expect(newThirdPosition.positionState).to.eq(1); // External
            expect(newThirdPosition.unit).to.eq(expectedThirdPositionUnit);
            expect(newThirdPosition.module).to.eq(aaveLeverageModule.address);

            expect(newFourthPosition.component).to.eq(setup.weth.address);
            expect(newFourthPosition.positionState).to.eq(1); // External
            expect(newFourthPosition.unit).to.eq(expectedFourthPositionUnit);
            expect(newFourthPosition.module).to.eq(aaveLeverageModule.address);
          });
        });

        describe("when SetToken is not valid", async () => {
          beforeEach(async () => {
            const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
              [setup.weth.address],
              [ether(1)],
              [aaveLeverageModule.address],
              owner.address
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
        setToken = await setup.createSetToken(
          [aWETH.address, aDAI.address],
          [ether(2), ether(1000)],
          [aaveLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
        );
        await debtIssuanceMock.initialize(setToken.address);
        // Add SetToken to allow list
        await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);

        // Initialize module if set to true
        await aaveLeverageModule.initialize(
          setToken.address,
          [setup.weth.address, setup.dai.address],
          [setup.dai.address, setup.weth.address]
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

        expect(currentPositions.length).to.eq(2);   // 2 Default positions
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
      setToken = await setup.createSetToken(
        [aWETH.address],
        [ether(1)],
        [aaveLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
      );
      await debtIssuanceMock.initialize(setToken.address);
      // Add SetToken to allow list
      await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
      // Initialize module if set to true
      if (isInitialized) {
        await aaveLeverageModule.initialize(
          setToken.address,
          [setup.weth.address],
          []
        );
      }
    };

    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
      subjectCollateralAssets = [setup.dai.address];
      subjectCaller = owner;
    };

    async function subject(): Promise<any> {
      return aaveLeverageModule.connect(subjectCaller.wallet).addCollateralAssets(
        subjectSetToken,
        subjectCollateralAssets,
      );
    }

    describe("when module is initialized", () => {
      beforeEach(() => {
        isInitialized = true;
      });

      cacheBeforeEach(initializeContracts);
      beforeEach(initializeSubjectVariables);

      it("should add the collateral asset to mappings", async () => {
        await subject();
        const collateralAssets = (await aaveLeverageModule.getEnabledAssets(setToken.address))[0];
        const isDaiCollateral = await aaveLeverageModule.collateralAssetEnabled(setToken.address, setup.dai.address);

        expect(JSON.stringify(collateralAssets)).to.eq(JSON.stringify([setup.weth.address, setup.dai.address]));
        expect(isDaiCollateral).to.be.true;
      });

      it("should emit the correct CollateralAssetsUpdated event", async () => {
        await expect(subject()).to.emit(aaveLeverageModule, "CollateralAssetsUpdated").withArgs(
          subjectSetToken,
          true,
          subjectCollateralAssets,
        );
      });

      context("before first issuance, aToken balance is zero", async () => {
        it("should not be able to enable collateral asset to be used as collateral on Aave", async () => {
          const beforeUsageAsCollateralEnabled = (
            await aaveSetup.protocolDataProvider.getUserReserveData(setup.dai.address, setToken.address)
          ).usageAsCollateralEnabled;
          await subject();
          const afterUsageAsCollateralEnabled = (
            await aaveSetup.protocolDataProvider.getUserReserveData(setup.dai.address, setToken.address)
          ).usageAsCollateralEnabled;

          expect(beforeUsageAsCollateralEnabled).to.be.false;
          expect(afterUsageAsCollateralEnabled).to.be.false;
        });
      });

      describe("when re-adding a removed collateral asset", async () => {
        beforeEach(async () => {
          // Mint aTokens
          await setup.weth.approve(aaveSetup.lendingPool.address, ether(1000));
          await aaveSetup.lendingPool.connect(owner.wallet).deposit(setup.weth.address, ether(1000), owner.address, ZERO);

          // Approve tokens to issuance module and call issue
          await aWETH.approve(setup.issuanceModule.address, ether(1000));

          // Transfer of aToken to SetToken during issuance would enable the underlying to be used as collateral by SetToken on Aave
          const issueQuantity = ether(1);
          await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
          await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

          // Now remove collateral asset to disable underlying to be used as collateral on Aave
          await aaveLeverageModule.removeCollateralAssets(setToken.address, [setup.weth.address]);

          subjectCollateralAssets = [setup.weth.address];   // re-add weth
        });

        it("should re-enable asset to be used as collateral on Aave", async () => {
          const beforeUsageAsCollateralEnabled = (
            await aaveSetup.protocolDataProvider.getUserReserveData(setup.weth.address, setToken.address)
          ).usageAsCollateralEnabled;
          await subject();
          const afterUsageAsCollateralEnabled = (
            await aaveSetup.protocolDataProvider.getUserReserveData(setup.weth.address, setToken.address)
          ).usageAsCollateralEnabled;
          expect(beforeUsageAsCollateralEnabled).to.be.false;
          expect(afterUsageAsCollateralEnabled).to.be.true;
        });
      });

      describe("when collateral asset is duplicated", async () => {
        beforeEach(async () => {
          subjectCollateralAssets = [setup.weth.address, setup.weth.address];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Collateral already enabled");
        });
      });

      describe("when a new Aave reserve is added as collateral", async () => {
        beforeEach(async () => {
          // Create a new reserve
          await aaveSetup.createAndEnableReserve(
            setup.usdc.address, "USDC", BigNumber.from(8),
            BigNumber.from(8000),   // base LTV: 80%
            BigNumber.from(8250),   // liquidation threshold: 82.5%
            BigNumber.from(10500),  // liquidation bonus: 105.00%
            BigNumber.from(1000),   // reserve factor: 10%
            true,                   // enable borrowing on reserve
            true                    // enable stable debts
          );

          subjectCollateralAssets = [setup.usdc.address];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Invalid aToken address");
        });

        describe("when updateUnderlyingToReserveTokenMappings is called before", async () => {
          beforeEach(async () => {
            await aaveLeverageModule.addUnderlyingToReserveTokensMapping(setup.usdc.address);
          });

          it("should add collateral asset to mappings", async () => {
            await subject();
            const collateralAssets = (await aaveLeverageModule.getEnabledAssets(setToken.address))[0];
            const isUsdcCollateral = await aaveLeverageModule.collateralAssetEnabled(setToken.address, setup.usdc.address);

            expect(JSON.stringify(collateralAssets)).to.eq(JSON.stringify([setup.weth.address, setup.usdc.address]));
            expect(isUsdcCollateral).to.be.true;
          });
        });
      });

      describe("when collateral asset does not exist on Aave", async () => {
        beforeEach(async () => {
          subjectCollateralAssets = [await getRandomAddress()];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Invalid aave reserve");
        });
      });

      describe("when collateral asset reserve is frozen on Aave", async () => {
        beforeEach(async () => {
          await aaveSetup.lendingPoolConfigurator.connect(owner.wallet).freezeReserve(setup.dai.address);
        });

        afterEach(async () => {
          await aaveSetup.lendingPoolConfigurator.connect(owner.wallet).unfreezeReserve(setup.dai.address);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Frozen aave reserve");
        });
      });

      describe("when LTV is zero and asset can not be used as collateral", async () => {
        beforeEach(async () => {
          await aaveSetup.createAndEnableReserve(
            setup.usdc.address, "USDC", BigNumber.from(18),
            ZERO,                 // base LTV: 0%
            ZERO,                 // liquidation threshold: 0%
            ZERO,                 // liquidation bonus: 105.00%
            BigNumber.from(1000), // reserve factor: 10%
            true,                 // enable borrowing on reserve
            false                 // enable stable debts
          );
          await aaveLeverageModule.addUnderlyingToReserveTokensMapping(setup.usdc.address);

          subjectCollateralAssets = [setup.usdc.address];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Collateral disabled on Aave");
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

  describe("#addBorrowAssets", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectBorrowAssets: Address[];
    let subjectCaller: Account;

    const initializeContracts = async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address, setup.dai.address],
        [ether(1), ether(100)],
        [aaveLeverageModule.address, debtIssuanceMock.address]
      );
      await debtIssuanceMock.initialize(setToken.address);
      // Add SetToken to allow list
      await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
      // Initialize module if set to true
      if (isInitialized) {
        await aaveLeverageModule.initialize(
          setToken.address,
          [],
          [setup.weth.address]
        );
      }
    };

    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
      subjectBorrowAssets = [setup.dai.address];
      subjectCaller = owner;
    };

    async function subject(): Promise<any> {
      return aaveLeverageModule.connect(subjectCaller.wallet).addBorrowAssets(
        subjectSetToken,
        subjectBorrowAssets,
      );
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
        const isDAIBorrow = await aaveLeverageModule.borrowAssetEnabled(setToken.address, setup.dai.address);

        expect(JSON.stringify(borrowAssets)).to.eq(JSON.stringify([setup.weth.address, setup.dai.address]));
        expect(isDAIBorrow).to.be.true;
      });

      it("should emit the correct BorrowAssetsUpdated event", async () => {
        await expect(subject()).to.emit(aaveLeverageModule, "BorrowAssetsUpdated").withArgs(
          subjectSetToken,
          true,
          subjectBorrowAssets,
        );
      });

      describe("when borrow asset is duplicated", async () => {
        beforeEach(async () => {
          subjectBorrowAssets = [setup.dai.address, setup.dai.address];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Borrow already enabled");
        });
      });

      describe("when a new Aave reserve is added as borrow", async () => {
        beforeEach(async () => {
          // Create a new reserve
          await aaveSetup.createAndEnableReserve(
            setup.usdc.address, "USDC", BigNumber.from(8),
            BigNumber.from(8000),   // base LTV: 80%
            BigNumber.from(8250),   // liquidation threshold: 82.5%
            BigNumber.from(10500),  // liquidation bonus: 105.00%
            BigNumber.from(1000),   // reserve factor: 10%
            true,                   // enable borrowing on reserve
            true                    // enable stable debts
          );

          subjectBorrowAssets = [setup.usdc.address];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Invalid variable debt token address");
        });

        describe("when updateUnderlyingToReserveTokenMappings is called before", async () => {
          beforeEach(async () => {
            await aaveLeverageModule.addUnderlyingToReserveTokensMapping(setup.usdc.address);
          });

          it("should add collateral asset to mappings", async () => {
            await subject();
            const borrowAssets = (await aaveLeverageModule.getEnabledAssets(setToken.address))[1];
            const isUsdcBorrow = await aaveLeverageModule.borrowAssetEnabled(setToken.address, setup.usdc.address);

            expect(JSON.stringify(borrowAssets)).to.eq(JSON.stringify([setup.weth.address, setup.usdc.address]));
            expect(isUsdcBorrow).to.be.true;
          });
        });
      });

      describe("when borrow asset reserve does not exist on Aave", async () => {
        beforeEach(async () => {
          subjectBorrowAssets = [await getRandomAddress()];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Invalid aave reserve");
        });
      });

      describe("when borrow asset reserve is frozen on Aave", async () => {
        beforeEach(async () => {
          await aaveSetup.lendingPoolConfigurator.connect(owner.wallet).freezeReserve(setup.dai.address);
        });

        afterEach(async () => {
          await aaveSetup.lendingPoolConfigurator.connect(owner.wallet).unfreezeReserve(setup.dai.address);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Frozen aave reserve");
        });
      });

      describe("when borrowing is disabled for an asset on Aave", async () => {
        beforeEach(async () => {
          await aaveSetup.createAndEnableReserve(
            setup.usdc.address,
            "USDC",
            BigNumber.from(6),
            BigNumber.from(8000),
            BigNumber.from(8200),
            BigNumber.from(10500),
            BigNumber.from(1000),
            false,
            false,
          );
          await aaveLeverageModule.addUnderlyingToReserveTokensMapping(setup.usdc.address);

          subjectBorrowAssets = [setup.dai.address, setup.usdc.address];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Borrowing disabled on Aave");
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
        await initializeSubjectVariables();
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
      await setup.controller.addModule(otherIssuanceModule.address);

      setToken = await setup.createSetToken(
        [aWETH.address],
        [ether(100)],
        [aaveLeverageModule.address, setup.issuanceModule.address, debtIssuanceMock.address]
      );
      await debtIssuanceMock.initialize(setToken.address);
      // Add SetToken to allow list
      await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
      // Initialize module if set to true
      if (isInitialized) {
        await aaveLeverageModule.initialize(
          setToken.address,
          [setup.weth.address, setup.dai.address, setup.wbtc.address],  // Enable WBTC that is not a Set position
          [setup.dai.address, setup.weth.address, setup.wbtc.address]
        );
      }
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
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
          const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
            [setup.weth.address],
            [ether(1)],
            [aaveLeverageModule.address],
            owner.address
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
          await expect(subject()).to.be.revertedWith("Issuance not initialized");
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
        await setup.controller.addModule(mockModule.address);

        setToken = await setup.createSetToken(
          [aWETH.address, aDAI.address],
          [ether(10), ether(5000)],
          [aaveLeverageModule.address, setup.issuanceModule.address, debtIssuanceMock.address]
        );
        await debtIssuanceMock.initialize(setToken.address);
        // Add SetToken to allow list
        await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
        // Initialize module if set to true
        if (isInitialized) {
          await aaveLeverageModule.initialize(
            setToken.address,
            [setup.weth.address, setup.dai.address, setup.wbtc.address],  // Enable WBTC that is not a Set position
            [setup.dai.address, setup.weth.address, setup.wbtc.address]
          );
        }
        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
        // Initialize mock module
        await setToken.addModule(mockModule.address);
        await setToken.connect(mockModule.wallet).initializeModule();

        // Add Set token as token sender / recipient
        await oneInchExchangeMockToWeth.addSetTokenAddress(setToken.address);
        await oneInchExchangeMockFromWeth.addSetTokenAddress(setToken.address);

        // Fund One Inch exchange with destinationToken WETH and DAI
        await setup.weth.transfer(oneInchExchangeMockToWeth.address, ether(10));
        await setup.dai.transfer(oneInchExchangeMockFromWeth.address, ether(10000));

        // Mint aTokens
        await setup.weth.approve(aaveSetup.lendingPool.address, ether(10));
        await aaveSetup.lendingPool.connect(owner.wallet).deposit(setup.weth.address, ether(10), owner.address, ZERO);
        await setup.dai.approve(aaveSetup.lendingPool.address, ether(10000));
        await aaveSetup.lendingPool.connect(owner.wallet).deposit(setup.dai.address, ether(10000), owner.address, ZERO);

        // Approve tokens to issuance module and call issue
        await aWETH.approve(setup.issuanceModule.address, ether(10));
        await aDAI.approve(setup.issuanceModule.address, ether(10000));

        // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 1000 DAI regardless of Set supply
        const issueQuantity = ether(1);
        await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Lever both aDAI and aWETH in SetToken
        if (isInitialized) {
          const leverEthTradeData = oneInchExchangeMockToWeth.interface.encodeFunctionData("swap", [
            setup.dai.address, // Send token
            setup.weth.address, // Receive token
            ether(1000), // Send quantity
            ether(1), // Min receive quantity
            ZERO,
            ADDRESS_ZERO,
            [ADDRESS_ZERO],
            EMPTY_BYTES,
            [ZERO],
            [ZERO],
          ]);

          await aaveLeverageModule.lever(
            setToken.address,
            setup.dai.address,
            setup.weth.address,
            ether(1000),
            ether(1),
            "ONEINCHTOWETH",
            leverEthTradeData
          );

          const leverDaiTradeData = oneInchExchangeMockToWeth.interface.encodeFunctionData("swap", [
            setup.weth.address, // Send token
            setup.dai.address, // Receive token
            ether(1), // Send quantity
            ether(1000), // Min receive quantity
            ZERO,
            ADDRESS_ZERO,
            [ADDRESS_ZERO],
            EMPTY_BYTES,
            [ZERO],
            [ZERO],
          ]);

          await aaveLeverageModule.lever(
            setToken.address,
            setup.weth.address,
            setup.dai.address,
            ether(1),
            ether(1000),
            "ONEINCHFROMWETH",
            leverDaiTradeData
          );
        }
      });

      beforeEach(() => {
        subjectSetToken = setToken.address;
        subjectCaller = mockModule;
      });

      async function subject(): Promise<any> {
        return aaveLeverageModule.connect(subjectCaller.wallet).moduleIssueHook(subjectSetToken, ZERO);
      }

      it("should update the collateral positions on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];
        const newSecondPosition = (await setToken.getPositions())[1];

        const expectedFirstPositionUnit = await aWETH.balanceOf(setToken.address);    // need not divide, since total Supply = 1
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

        const expectedThirdPositionUnit = (await variableDebtDAI.balanceOf(setToken.address)).mul(-1);    // since, variable debt mode
        const expectedFourthPositionUnit = (await variableDebtWETH.balanceOf(setToken.address)).mul(-1);

        expect(initialPositions.length).to.eq(4);
        expect(currentPositions.length).to.eq(4);

        expect(newThirdPosition.component).to.eq(setup.dai.address);
        expect(newThirdPosition.positionState).to.eq(1); // External
        expect(newThirdPosition.unit).to.eq(expectedThirdPositionUnit);
        expect(newThirdPosition.module).to.eq(aaveLeverageModule.address);

        expect(newFourthPosition.component).to.eq(setup.weth.address);
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
          await setup.controller.removeModule(mockModule.address);
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
        await setup.controller.addModule(mockModule.address);

        setToken = await setup.createSetToken(
          [aWETH.address, aDAI.address],
          [ether(10), ether(5000)],
          [aaveLeverageModule.address, setup.issuanceModule.address, debtIssuanceMock.address]
        );
        await debtIssuanceMock.initialize(setToken.address);
        // Add SetToken to allow list
        await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
        // Initialize module if set to true
        if (isInitialized) {
          await aaveLeverageModule.initialize(
            setToken.address,
            [setup.weth.address, setup.dai.address, setup.wbtc.address],  // Enable WBTC that is not a Set position
            [setup.dai.address, setup.weth.address, setup.wbtc.address]
          );
        }
        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
        // Initialize mock module
        await setToken.addModule(mockModule.address);
        await setToken.connect(mockModule.wallet).initializeModule();

        // Add Set token as token sender / recipient
        await oneInchExchangeMockToWeth.addSetTokenAddress(setToken.address);
        await oneInchExchangeMockFromWeth.addSetTokenAddress(setToken.address);

        // Fund One Inch exchange with destinationToken WETH and DAI
        await setup.weth.transfer(oneInchExchangeMockToWeth.address, ether(10));
        await setup.dai.transfer(oneInchExchangeMockFromWeth.address, ether(10000));

        // Mint aTokens
        await setup.weth.approve(aaveSetup.lendingPool.address, ether(10));
        await aaveSetup.lendingPool.connect(owner.wallet).deposit(setup.weth.address, ether(10), owner.address, ZERO);
        await setup.dai.approve(aaveSetup.lendingPool.address, ether(10000));
        await aaveSetup.lendingPool.connect(owner.wallet).deposit(setup.dai.address, ether(10000), owner.address, ZERO);

        // Approve tokens to issuance module and call issue
        await aWETH.approve(setup.issuanceModule.address, ether(10));
        await aDAI.approve(setup.issuanceModule.address, ether(10000));

        // Issue 10 SetToken. Note: 1inch mock is hardcoded to trade 1000 DAI regardless of Set supply
        const issueQuantity = ether(1);
        await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Lever both aDAI and aWETH in SetToken
        if (isInitialized) {
          const leverEthTradeData = oneInchExchangeMockToWeth.interface.encodeFunctionData("swap", [
            setup.dai.address, // Send token
            setup.weth.address, // Receive token
            ether(1000), // Send quantity
            ether(1), // Min receive quantity
            ZERO,
            ADDRESS_ZERO,
            [ADDRESS_ZERO],
            EMPTY_BYTES,
            [ZERO],
            [ZERO],
          ]);

          await aaveLeverageModule.lever(
            setToken.address,
            setup.dai.address,
            setup.weth.address,
            ether(1000),
            ether(1),
            "ONEINCHTOWETH",
            leverEthTradeData
          );

          const leverDaiTradeData = oneInchExchangeMockToWeth.interface.encodeFunctionData("swap", [
            setup.weth.address, // Send token
            setup.dai.address, // Receive token
            ether(1), // Send quantity
            ether(1000), // Min receive quantity
            ZERO,
            ADDRESS_ZERO,
            [ADDRESS_ZERO],
            EMPTY_BYTES,
            [ZERO],
            [ZERO],
          ]);

          await aaveLeverageModule.lever(
            setToken.address,
            setup.weth.address,
            setup.dai.address,
            ether(1),
            ether(1000),
            "ONEINCHFROMWETH",
            leverDaiTradeData
          );
        }
      });

      beforeEach(() => {
        subjectSetToken = setToken.address;
        subjectCaller = mockModule;
      });

      async function subject(): Promise<any> {
        return aaveLeverageModule.connect(subjectCaller.wallet).moduleRedeemHook(subjectSetToken, ZERO);
      }

      it("should update the collateral positions on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];
        const newSecondPosition = (await setToken.getPositions())[1];

        const expectedFirstPositionUnit = await aWETH.balanceOf(setToken.address);    // need not divide, since total Supply = 1
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

        const expectedThirdPositionUnit = (await variableDebtDAI.balanceOf(setToken.address)).mul(-1);    // since, variable debt mode
        const expectedFourthPositionUnit = (await variableDebtWETH.balanceOf(setToken.address)).mul(-1);

        expect(initialPositions.length).to.eq(4);
        expect(currentPositions.length).to.eq(4);

        expect(newThirdPosition.component).to.eq(setup.dai.address);
        expect(newThirdPosition.positionState).to.eq(1); // External
        expect(newThirdPosition.unit).to.eq(expectedThirdPositionUnit);
        expect(newThirdPosition.module).to.eq(aaveLeverageModule.address);

        expect(newFourthPosition.component).to.eq(setup.weth.address);
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
          await setup.controller.removeModule(mockModule.address);
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
        await setup.controller.addModule(mockModule.address);

        setToken = await setup.createSetToken(
          [aWETH.address],
          [ether(2)],
          [aaveLeverageModule.address, setup.issuanceModule.address, debtIssuanceMock.address]
        );
        await debtIssuanceMock.initialize(setToken.address);
        // Add SetToken to allow list
        await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
        // Initialize module if set to true
        if (isInitialized) {
          await aaveLeverageModule.initialize(
            setToken.address,
            [setup.weth.address, setup.dai.address, setup.wbtc.address],  // Enable WBTC that is not a Set position
            [setup.dai.address, setup.weth.address, setup.wbtc.address]
          );
        }
        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
        // Initialize mock module
        await setToken.addModule(mockModule.address);
        await setToken.connect(mockModule.wallet).initializeModule();

        // Add Set token as token sender / recipient
        await oneInchExchangeMockToWeth.addSetTokenAddress(setToken.address);

        // Fund One Inch exchange with destinationToken WETH and DAI
        await setup.weth.transfer(oneInchExchangeMockToWeth.address, ether(10));

        // Mint aTokens
        await setup.weth.approve(aaveSetup.lendingPool.address, ether(100));
        await aaveSetup.lendingPool.connect(owner.wallet).deposit(setup.weth.address, ether(100), owner.address, ZERO);

        // Approve tokens to issuance module and call issue
        await aWETH.connect(owner.wallet).approve(setup.issuanceModule.address, ether(100));

        issueQuantity = ether(1);
        await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 1000 DAI regardless of Set supply
        borrowQuantity = ether(1000);
        if (isInitialized) {
          // Lever cETH in SetToken
          const leverEthTradeData = oneInchExchangeMockToWeth.interface.encodeFunctionData("swap", [
            setup.dai.address, // Send token
            setup.weth.address, // Receive token
            borrowQuantity, // Send quantity
            ether(0.9), // Min receive quantity
            ZERO,
            ADDRESS_ZERO,
            [ADDRESS_ZERO],
            EMPTY_BYTES,
            [ZERO],
            [ZERO],
          ]);

          await aaveLeverageModule.lever(
            setToken.address,
            setup.dai.address,
            setup.weth.address,
            borrowQuantity,
            ether(0.9),
            "ONEINCHTOWETH",
            leverEthTradeData
          );
        }
      });

      beforeEach(() => {
        subjectSetToken = setToken.address;
        subjectSetQuantity = issueQuantity;
        subjectComponent = setup.dai.address;
        subjectIsEquity = false;
        subjectCaller = mockModule;
      });

      async function subject(): Promise<any> {
        return aaveLeverageModule.connect(subjectCaller.wallet).componentIssueHook(
          subjectSetToken,
          subjectSetQuantity,
          subjectComponent,
          subjectIsEquity
        );
      }

      it("should increase borrowed quantity on the SetToken", async () => {
        const previousDaiBalance = await setup.dai.balanceOf(setToken.address);

        await subject();

        const currentDaiBalance = await setup.dai.balanceOf(setToken.address);

        expect(previousDaiBalance).to.eq(ZERO);
        expect(currentDaiBalance).to.eq(preciseMul(borrowQuantity, subjectSetQuantity));
      });

      describe("when isEquity is false and component has positive unit (should not happen)", async () => {
        beforeEach(async () => {
          subjectComponent = aWETH.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Component must be negative");
        });
      });

      describe("when isEquity is true", async () => {
        beforeEach(async () => {
          subjectIsEquity = true;
        });

        it("should NOT increase borrowed quantity on the SetToken", async () => {
          const previousDaiBalance = await setup.dai.balanceOf(setToken.address);

          await subject();

          const currentDaiBalance = await setup.dai.balanceOf(setToken.address);

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
          await setup.controller.removeModule(mockModule.address);
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
        await setup.controller.addModule(mockModule.address);

        setToken = await setup.createSetToken(
          [aWETH.address],
          [ether(2)],
          [aaveLeverageModule.address, setup.issuanceModule.address, debtIssuanceMock.address]
        );
        await debtIssuanceMock.initialize(setToken.address);
        // Add SetToken to allow list
        await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
        // Initialize module if set to true
        if (isInitialized) {
          await aaveLeverageModule.initialize(
            setToken.address,
            [setup.weth.address, setup.wbtc.address],  // Enable WBTC that is not a Set position
            [setup.dai.address, setup.wbtc.address]
          );
        }
        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
        // Initialize mock module
        await setToken.addModule(mockModule.address);
        await setToken.connect(mockModule.wallet).initializeModule();

        // Add Set token as token sender / recipient
        await oneInchExchangeMockToWeth.addSetTokenAddress(setToken.address);

        // Fund One Inch exchange with destinationToken WETH and DAI
        await setup.weth.transfer(oneInchExchangeMockToWeth.address, ether(10));

        // Mint aTokens
        await setup.weth.approve(aaveSetup.lendingPool.address, ether(100));
        await aaveSetup.lendingPool.connect(owner.wallet).deposit(setup.weth.address, ether(100), owner.address, ZERO);

        // Approve tokens to issuance module and call issue
        await aWETH.connect(owner.wallet).approve(setup.issuanceModule.address, ether(100));

        issueQuantity = ether(1);
        await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 1000 DAI regardless of Set supply
        repayQuantity = ether(1000);

        // Lever aETH in SetToken
        if (isInitialized) {
          const leverEthTradeData = oneInchExchangeMockToWeth.interface.encodeFunctionData("swap", [
            setup.dai.address, // Send token
            setup.weth.address, // Receive token
            repayQuantity, // Send quantity
            ether(0.1), // Min receive quantity
            ZERO,
            ADDRESS_ZERO,
            [ADDRESS_ZERO],
            EMPTY_BYTES,
            [ZERO],
            [ZERO],
          ]);

          await aaveLeverageModule.lever(
            setToken.address,
            setup.dai.address,
            setup.weth.address,
            repayQuantity,
            ether(0.1),
            "ONEINCHTOWETH",
            leverEthTradeData
          );
        }

        // Transfer repay quantity to SetToken for repayment
        await setup.dai.transfer(setToken.address, repayQuantity);
      });

      beforeEach(() => {
        subjectSetToken = setToken.address;
        subjectSetQuantity = issueQuantity;
        subjectComponent = setup.dai.address;
        subjectIsEquity = false;
        subjectCaller = mockModule;
      });

      async function subject(): Promise<any> {
        return aaveLeverageModule.connect(subjectCaller.wallet).componentRedeemHook(
          subjectSetToken,
          subjectSetQuantity,
          subjectComponent,
          subjectIsEquity
        );
      }

      it("should decrease borrowed quantity on the SetToken", async () => {
        const previousDaiBalance = await setup.dai.balanceOf(setToken.address);

        await subject();

        const currentDaiBalance = await setup.dai.balanceOf(setToken.address);

        expect(previousDaiBalance).to.eq(repayQuantity);
        expect(currentDaiBalance).to.eq(ZERO);
      });

      describe("when _isEquity is false and component has positive unit", async () => {
        beforeEach(async () => {
          subjectComponent = aWETH.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Component must be negative");
        });
      });

      describe("when isEquity is true", async () => {
        beforeEach(async () => {
          subjectIsEquity = true;
        });

        it("should NOT decrease borrowed quantity on the SetToken", async () => {
          const previousDaiBalance = await setup.dai.balanceOf(setToken.address);

          await subject();

          const currentDaiBalance = await setup.dai.balanceOf(setToken.address);

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
          await setup.controller.removeModule(mockModule.address);
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
      setToken = await setup.createSetToken(
        [aWETH.address],
        [ether(100)],
        [aaveLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
      );
      await debtIssuanceMock.initialize(setToken.address);
      // Add SetToken to allow list
      await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
      await aaveLeverageModule.initialize(
        setToken.address,
        [setup.weth.address],
        [setup.weth.address, setup.dai.address]
      );
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

      // Mint aTokens
      await setup.weth.approve(aaveSetup.lendingPool.address, ether(1000));
      await aaveSetup.lendingPool.connect(owner.wallet).deposit(setup.weth.address, ether(1000), owner.address, ZERO);

      // Approve tokens to issuance module and call issue
      await aWETH.approve(setup.issuanceModule.address, ether(1000));

      await setup.issuanceModule.issue(setToken.address, ether(1), owner.address);
    });

    beforeEach(() => {
      subjectModule = aaveLeverageModule.address;
    });

    async function subject(): Promise<any> {
      return setToken.removeModule(subjectModule);
    }

    it("should remove the Module on the SetToken", async () => {
      await subject();
      const isModuleEnabled = await setToken.isInitializedModule(aaveLeverageModule.address);
      expect(isModuleEnabled).to.be.false;
    });

    it("should delete the mappings", async () => {
      await subject();
      const collateralAssets = (await aaveLeverageModule.getEnabledAssets(setToken.address))[0];
      const borrowAssets = (await aaveLeverageModule.getEnabledAssets(setToken.address))[1];
      const isWethCollateral = await aaveLeverageModule.collateralAssetEnabled(setToken.address, setup.weth.address);
      const isDaiCollateral = await aaveLeverageModule.collateralAssetEnabled(setToken.address, setup.weth.address);
      const isDaiBorrow = await aaveLeverageModule.borrowAssetEnabled(setToken.address, setup.weth.address);
      const isEtherBorrow = await aaveLeverageModule.borrowAssetEnabled(setToken.address, setup.weth.address);

      expect(collateralAssets.length).to.eq(0);
      expect(borrowAssets.length).to.eq(0);
      expect(isWethCollateral).to.be.false;
      expect(isDaiCollateral).to.be.false;
      expect(isDaiBorrow).to.be.false;
      expect(isEtherBorrow).to.be.false;
    });

    it("should unregister on the debt issuance module", async () => {
      await subject();
      const isRegistered = await debtIssuanceMock.isRegistered(setToken.address);
      expect(isRegistered).to.be.false;
    });

    describe("when borrow balance exists", async () => {
      beforeEach(async () => {
        // Add Set token as token sender / recipient
        oneInchExchangeMockToWeth = oneInchExchangeMockToWeth.connect(owner.wallet);
        await oneInchExchangeMockToWeth.addSetTokenAddress(setToken.address);

        // Fund One Inch exchange with destinationToken WETH
        await setup.weth.transfer(oneInchExchangeMockToWeth.address, ether(10));

        // Lever SetToken
        const leverTradeData = oneInchExchangeMockToWeth.interface.encodeFunctionData("swap", [
          setup.dai.address, // Send token
          setup.weth.address, // Receive token
          ether(1000), // Send quantity
          ether(1), // Min receive quantity
          ZERO,
          ADDRESS_ZERO,
          [ADDRESS_ZERO],
          EMPTY_BYTES,
          [ZERO],
          [ZERO],
        ]);

        await aaveLeverageModule.lever(
          setToken.address,
          setup.dai.address,
          setup.weth.address,
          ether(1000),
          ether(1),
          "ONEINCHTOWETH",
          leverTradeData
        );
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Variable debt remaining");
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
      setToken = await setup.createSetToken(
        [aWETH.address],
        [ether(1)],
        [aaveLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
      );
      await debtIssuanceMock.initialize(setToken.address);
      // Add SetToken to allow list
      await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
      // Initialize module if set to true
      if (isInitialized) {
        await aaveLeverageModule.initialize(
          setToken.address,
          [setup.weth.address, setup.dai.address],
          []
        );
      }
    };

    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
      subjectCollateralAssets = [setup.dai.address];
      subjectCaller = owner;
    };

    async function subject(): Promise<any> {
      return await aaveLeverageModule.connect(subjectCaller.wallet).removeCollateralAssets(
        subjectSetToken,
        subjectCollateralAssets,
      );
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
        const isDAICollateral = await aaveLeverageModule.collateralAssetEnabled(setToken.address, setup.dai.address);
        expect(JSON.stringify(collateralAssets)).to.eq(JSON.stringify([setup.weth.address]));
        expect(isDAICollateral).to.be.false;
      });

      it("should emit the correct CollateralAssetsUpdated event", async () => {
        await expect(subject()).to.emit(aaveLeverageModule, "CollateralAssetsUpdated").withArgs(
          subjectSetToken,
          false,
          subjectCollateralAssets,
        );
      });

      describe("when removing a collateral asset which has been enabled to be used as collateral on aave", async () => {
        beforeEach(async () => {
          // Mint aTokens
          await setup.weth.approve(aaveSetup.lendingPool.address, ether(1000));
          await aaveSetup.lendingPool.connect(owner.wallet).deposit(setup.weth.address, ether(1000), owner.address, ZERO);

          // Approve tokens to issuance module and call issue
          await aWETH.approve(setup.issuanceModule.address, ether(1000));

          // Transfer of aToken to SetToken during issuance would enable the underlying to be used as collateral by SetToken on Aave
          const issueQuantity = ether(1);
          await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
          await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

          subjectCollateralAssets = [setup.weth.address];   // remove weth
        });

        it("should disable the asset to be used as collateral on aave", async () => {
          const beforeUsageAsCollateralEnabled = (
            await aaveSetup.protocolDataProvider.getUserReserveData(setup.weth.address, setToken.address)
          ).usageAsCollateralEnabled;
          await subject();
          const afterUsageAsCollateralEnabled = (
            await aaveSetup.protocolDataProvider.getUserReserveData(setup.weth.address, setToken.address)
          ).usageAsCollateralEnabled;
          expect(beforeUsageAsCollateralEnabled).to.be.true;
          expect(afterUsageAsCollateralEnabled).to.be.false;
        });
      });

      describe("when collateral asset is not enabled on module", async () => {
        beforeEach(async () => {
          subjectCollateralAssets = [setup.weth.address, setup.usdc.address];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Collateral not enabled");
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
      setToken = await setup.createSetToken(
        [aWETH.address],
        [ether(2)],
        [aaveLeverageModule.address, setup.issuanceModule.address, debtIssuanceMock.address]
      );
      await debtIssuanceMock.initialize(setToken.address);
      // Add SetToken to allow list
      await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

      // Mint aTokens
      await setup.weth.approve(aaveSetup.lendingPool.address, ether(1000));
      await aaveSetup.lendingPool.connect(owner.wallet).deposit(setup.weth.address, ether(1000), owner.address, ZERO);

      // Approve tokens to issuance module and call issue
      await aWETH.approve(setup.issuanceModule.address, ether(1000));

      // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 1000 DAI regardless of Set supply
      const issueQuantity = ether(1);
      await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

      // Initialize module if set to true
      if (isInitialized) {
        await aaveLeverageModule.initialize(
          setToken.address,
          [setup.weth.address],
          [setup.weth.address, setup.dai.address]
        );
      }
    };

    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
      subjectBorrowAssets = [setup.dai.address];
      subjectCaller = owner;
    };

    async function subject(): Promise<any> {
      return aaveLeverageModule.connect(subjectCaller.wallet).removeBorrowAssets(
        subjectSetToken,
        subjectBorrowAssets,
      );
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
        const isDAIBorrow = await aaveLeverageModule.borrowAssetEnabled(setToken.address, setup.dai.address);
        expect(JSON.stringify(borrowAssets)).to.eq(JSON.stringify([setup.weth.address]));
        expect(isDAIBorrow).to.be.false;
      });

      it("should emit the correct BorrowAssetsUpdated event", async () => {
        await expect(subject()).to.emit(aaveLeverageModule, "BorrowAssetsUpdated").withArgs(
          subjectSetToken,
          false,
          subjectBorrowAssets,
        );
      });

      describe("when borrow asset is not enabled on module", async () => {
        beforeEach(async () => {
          subjectBorrowAssets = [setup.dai.address, setup.dai.address];
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Borrow not enabled");
        });
      });

      describe("when borrow balance exists", async () => {
        beforeEach(async () => {
          // Add Set token as token sender / recipient
          oneInchExchangeMockToWeth = oneInchExchangeMockToWeth.connect(owner.wallet);
          await oneInchExchangeMockToWeth.addSetTokenAddress(setToken.address);

          // Fund One Inch exchange with destinationToken WETH
          await setup.weth.transfer(oneInchExchangeMockToWeth.address, ether(10));

          // Lever SetToken
          const leverTradeData = oneInchExchangeMockToWeth.interface.encodeFunctionData("swap", [
            setup.dai.address, // Send token
            setup.weth.address, // Receive token
            ether(1000), // Send quantity
            ether(1), // Min receive quantity
            ZERO,
            ADDRESS_ZERO,
            [ADDRESS_ZERO],
            EMPTY_BYTES,
            [ZERO],
            [ZERO],
          ]);

          await aaveLeverageModule.lever(
            setToken.address,
            setup.dai.address,
            setup.weth.address,
            ether(1000),
            ether(1),
            "ONEINCHTOWETH",
            leverTradeData
          );
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Variable debt remaining");
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
      setToken = setToken = await setup.createSetToken(
        [aWETH.address],
        [ether(2)],
        [aaveLeverageModule.address, debtIssuanceMock.address]
      );

      subjectSetToken = setToken.address;
      subjectStatus = true;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return aaveLeverageModule.connect(subjectCaller.wallet).updateAllowedSetToken(subjectSetToken, subjectStatus);
    }

    it("should add Set to allow list", async () => {
      await subject();

      const isAllowed = await aaveLeverageModule.allowedSetTokens(subjectSetToken);

      expect(isAllowed).to.be.true;
    });

    it("should emit the correct SetTokenStatusUpdated event", async () => {
      await expect(subject()).to.emit(aaveLeverageModule, "SetTokenStatusUpdated").withArgs(
        subjectSetToken,
        subjectStatus
      );
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
        await expect(subject()).to.emit(aaveLeverageModule, "SetTokenStatusUpdated").withArgs(
          subjectSetToken,
          subjectStatus
        );
      });

      describe("when Set Token is removed on controller", async () => {
        beforeEach(async () => {
          await setup.controller.removeSet(setToken.address);
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
        await setup.controller.removeSet(setToken.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid SetToken");
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
      return aaveLeverageModule.connect(subjectCaller.wallet).updateAnySetAllowed(subjectAnySetAllowed);
    }

    it("should remove Set from allow list", async () => {
      await subject();

      const anySetAllowed = await aaveLeverageModule.anySetAllowed();

      expect(anySetAllowed).to.be.true;
    });

    it("should emit the correct AnySetAllowedUpdated event", async () => {
      await expect(subject()).to.emit(aaveLeverageModule, "AnySetAllowedUpdated").withArgs(
        subjectAnySetAllowed
      );
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

    let usdcReserveTokens: ReserveTokens;

    cacheBeforeEach(async () => {
      usdcReserveTokens = await aaveSetup.createAndEnableReserve(
        setup.usdc.address, "USDC", BigNumber.from(8),
        BigNumber.from(8000),   // base LTV: 80%
        BigNumber.from(8250),   // liquidation threshold: 82.5%
        BigNumber.from(10500),  // liquidation bonus: 105.00%
        BigNumber.from(1000),   // reserve factor: 10%
        true,                   // enable borrowing on reserve
        true                    // enable stable debts
      );
    });

    beforeEach(async () => {
      subjectUnderlying = setup.usdc.address;
      subjectCaller = await getRandomAccount();
    });

    async function subject(): Promise<any> {
      return aaveLeverageModule.connect(subjectCaller.wallet).addUnderlyingToReserveTokensMapping(
        subjectUnderlying
      );
    }


    it("should add the underlying to reserve tokens mappings", async () => {
      await subject();

      const reserveTokens = await aaveLeverageModule.underlyingToReserveTokens(setup.usdc.address);

      expect(reserveTokens.aToken).to.eq(usdcReserveTokens.aToken.address);
      expect(reserveTokens.variableDebtToken).to.eq(usdcReserveTokens.variableDebtToken.address);
    });

    it("should emit ReserveTokensUpdated event", async () => {
      await expect(subject()).to.emit(aaveLeverageModule, "ReserveTokensUpdated").withArgs(
        setup.usdc.address,
        usdcReserveTokens.aToken.address,
        usdcReserveTokens.variableDebtToken.address
      );
    });

    describe("when mapping already exists", async () => {
      beforeEach(async () => {
        subjectUnderlying = setup.weth.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Mapping already exists");
      });
    });

    describe("when reserve is invalid", async () => {
      beforeEach(async () => {
        subjectUnderlying = await getRandomAddress();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid aave reserve");
      });
    });
  });
});
