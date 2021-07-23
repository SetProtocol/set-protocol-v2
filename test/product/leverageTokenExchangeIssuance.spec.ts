import "module-alias/register";
import { Account } from "@utils/test/types";
import {
  CompoundLeverageModule,
  DebtIssuanceModule,
  FlashLoanMock,
  LeverageTokenExchangeIssuance,
  ManagerIssuanceHookMock,
  SetToken,
  UniswapV2ExchangeAdapter
} from "@utils/contracts";
import { CEther, CERc20 } from "@utils/contracts/compound";
import DeployHelper from "@utils/deploys";
import {
  ether,
  usdc
} from "@utils/index";
import {
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  getCompoundFixture,
  getUniswapFixture,
  addSnapshotBeforeRestoreAfterEach,
  getRandomAddress
} from "@utils/test/index";
import {
  CompoundFixture,
  SystemFixture,
  UniswapFixture
} from "@utils/fixtures";
import { BigNumber } from "@ethersproject/bignumber";
import { ADDRESS_ZERO, ZERO, EMPTY_BYTES, MAX_UINT_256 } from "@utils/constants";
import { Address } from "hardhat-deploy/dist/types";

const expect = getWaffleExpect();

describe("LeverageTokenExchangeIssuance", () => {

  let owner: Account;
  let user: Account;

  let setV2Setup: SystemFixture;
  let compoundSetup: CompoundFixture;
  let uniswapSetup: UniswapFixture;

  let uniswapTradeAdapter: UniswapV2ExchangeAdapter;

  let deployer: DeployHelper;
  let setToken: SetToken;
  let cEther: CEther;
  let cUSDC: CERc20;

  let compoundLeverageModule: CompoundLeverageModule;
  let debtIssuanceModule: DebtIssuanceModule;
  let managerIssuanceHook: ManagerIssuanceHookMock;

  let flashLoanMock: FlashLoanMock;

  let leverageExchangeIssuance: LeverageTokenExchangeIssuance;

  before(async () => {
    [ owner, user ] = await getAccounts();
    deployer = new DeployHelper(owner.wallet);

    setV2Setup = getSystemFixture(owner.address);
    await setV2Setup.initialize();

    compoundSetup = getCompoundFixture(owner.address);
    compoundSetup.initialize();

    uniswapSetup = getUniswapFixture(owner.address);
    await uniswapSetup.initialize(owner, setV2Setup.weth.address, setV2Setup.wbtc.address, setV2Setup.dai.address);
    uniswapTradeAdapter = await deployer.adapters.deployUniswapV2ExchangeAdapter(uniswapSetup.router.address);
    await uniswapSetup.createNewPair(setV2Setup.weth.address, setV2Setup.usdc.address);

    await setV2Setup.weth.approve(uniswapSetup.router.address, MAX_UINT_256);
    await setV2Setup.usdc.approve(uniswapSetup.router.address, MAX_UINT_256);
    await uniswapSetup.router.addLiquidity(
      setV2Setup.weth.address,
      setV2Setup.usdc.address,
      ether(1000),
      usdc(2000000),
      0,
      0,
      owner.address,
      MAX_UINT_256
    );

    cEther = await compoundSetup.createAndEnableCEther(
      ether(200000000),
      compoundSetup.comptroller.address,
      compoundSetup.interestRateModel.address,
      "Compound ether",
      "cETH",
      8,
      ether(0.75), // 75% collateral factor
      ether(2000)   // $1000
    );

    cUSDC = await compoundSetup.createAndEnableCToken(
      setV2Setup.usdc.address,
      200000000000000,
      compoundSetup.comptroller.address,
      compoundSetup.interestRateModel.address,
      "Compound USDC",
      "cUSDC",
      8,
      ether(0.75), // 75% collateral factor
      ether(1000000000000) // IMPORTANT: Compound oracles account for decimals scaled by 10e18. For USDC, this is $1 * 10^18 * 10^18 / 10^6 = 10^30
    );

    await compoundSetup.comptroller._setCompRate(ether(1));
    await compoundSetup.comptroller._addCompMarkets([cEther.address, cUSDC.address]);

    // Mint cTokens
    await setV2Setup.usdc.approve(cUSDC.address, ether(100000));
    await cUSDC.mint(ether(1));
    await cEther.mint({value: ether(10000)});

    // Deploy DebtIssuanceModule
    debtIssuanceModule = await deployer.modules.deployDebtIssuanceModule(setV2Setup.controller.address);
    setV2Setup.controller.addModule(debtIssuanceModule.address);

    // Deploy Compound leverage module and add to controller
    const compoundLibrary = await deployer.libraries.deployCompound();
    compoundLeverageModule = await deployer.modules.deployCompoundLeverageModule(
      setV2Setup.controller.address,
      compoundSetup.comp.address,
      compoundSetup.comptroller.address,
      cEther.address,
      setV2Setup.weth.address,
      "contracts/protocol/integration/lib/Compound.sol:Compound",
      compoundLibrary.address,
    );
    await setV2Setup.controller.addModule(compoundLeverageModule.address);

    // Set integrations for CompoundLeverageModule
    await setV2Setup.integrationRegistry.addIntegration(
      compoundLeverageModule.address,
      "UniswapTradeAdapter",
      uniswapTradeAdapter.address,
    );

    await setV2Setup.integrationRegistry.addIntegration(
      compoundLeverageModule.address,
      "DefaultIssuanceModule",
      debtIssuanceModule.address,
    );

    // Deploy Set Token
    setToken = await setV2Setup.createSetToken(
      [cEther.address],
      [ether("0.000000005")],
      [compoundLeverageModule.address, debtIssuanceModule.address]
    );

    // initialize modules
    managerIssuanceHook = await deployer.mocks.deployManagerIssuanceHookMock();
    await debtIssuanceModule.initialize(setToken.address, 0, 0, 0, owner.address, managerIssuanceHook.address);

    await compoundLeverageModule.updateAllowedSetToken(setToken.address, true);
    await compoundLeverageModule.initialize(
      setToken.address,
      [setV2Setup.weth.address],
      [setV2Setup.usdc.address],
    );

    // issue some sets
    await cEther.approve(debtIssuanceModule.address, MAX_UINT_256);
    await debtIssuanceModule.issue(setToken.address, ether(1), owner.address);

    // lever up
    await compoundLeverageModule.lever(
      setToken.address,
      setV2Setup.usdc.address,
      setV2Setup.weth.address,
      usdc(1000),
      0,
      "UniswapTradeAdapter",
      EMPTY_BYTES
    );

    // deploy flash loan mock
    flashLoanMock = await deployer.mocks.deployFlashLoanMock();

    // deploy LeverageTokenExchangeIssuance
    leverageExchangeIssuance = await deployer.product.deployLeverageTokenExchangeIssuance(
      debtIssuanceModule.address,
      compoundLeverageModule.address,
      ADDRESS_ZERO,
      flashLoanMock.address,
      cEther.address,
      setV2Setup.weth.address
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {

    let subjectDebtIssuanceModule: Address;
    let subjectCompLeverageModule: Address;
    let subjectAaveLeverageModule: Address;
    let subjectFlashLoanMock: Address;
    let subjectCEther: Address;
    let subjectWeth: Address;

    beforeEach(async  () => {
      subjectDebtIssuanceModule = debtIssuanceModule.address;
      subjectCompLeverageModule = compoundLeverageModule.address;
      subjectAaveLeverageModule = await getRandomAddress();
      subjectFlashLoanMock = flashLoanMock.address;
      subjectCEther = cEther.address;
      subjectWeth = setV2Setup.weth.address;
    });

    async function subject(): Promise<LeverageTokenExchangeIssuance> {
      return await deployer.product.deployLeverageTokenExchangeIssuance(
        subjectDebtIssuanceModule,
        subjectCompLeverageModule,
        subjectAaveLeverageModule,
        subjectFlashLoanMock,
        subjectCEther,
        subjectWeth
      );
    }

    it("should set the state variables correctly", async () => {
      const leverageExchangeIssuance = await subject();

      expect(await leverageExchangeIssuance.debtIssuanceModule()).to.eq(subjectDebtIssuanceModule);
      expect(await leverageExchangeIssuance.compLeverageModule()).to.eq(subjectCompLeverageModule);
      expect(await leverageExchangeIssuance.aaveLeverageModule()).to.eq(subjectAaveLeverageModule);
      expect(await leverageExchangeIssuance.aaveLendingPool()).to.eq(subjectFlashLoanMock);
      expect(await leverageExchangeIssuance.cEth()).to.eq(subjectCEther);
      expect(await leverageExchangeIssuance.weth()).to.eq(subjectWeth);
    });
  });

  describe("#issueExactOutput", async () => {

    let subjectCaller: Account;
    let subjectSetToken: SetToken;
    let subjectSetAmount: BigNumber;
    let subjectMaxInput: BigNumber;
    let subjectInputToken: Address;
    let subjectInputRouter: Address;
    let subjectInputPath: Address[];
    let subjectDebtRouter: Address;
    let subjectDebtPath: Address[];

    beforeEach(async () => {

      subjectCaller = user;
      subjectSetToken = setToken;
      subjectSetAmount = ether(2);
      subjectMaxInput = MAX_UINT_256;
      subjectInputToken = setV2Setup.weth.address;
      subjectInputRouter = uniswapSetup.router.address;
      subjectInputPath = [];
      subjectDebtRouter = uniswapSetup.router.address;
      subjectDebtPath = [setV2Setup.usdc.address, setV2Setup.weth.address];

      // prep trader
      await setV2Setup.weth.transfer(subjectCaller.address, ether(1000));
      await setV2Setup.weth.connect(subjectCaller.wallet).approve(leverageExchangeIssuance.address, MAX_UINT_256);

      // add funds to flash loan mock
      await setV2Setup.weth.transfer(flashLoanMock.address, ether(1000));
    });

    async function subject(): Promise<void> {
      await leverageExchangeIssuance.connect(subjectCaller.wallet).issueExactOutput(
        subjectSetToken.address,
        subjectSetAmount,
        subjectMaxInput,
        subjectInputToken,
        subjectInputRouter,
        subjectInputPath,
        subjectDebtRouter,
        subjectDebtPath
      );
    }

    it("it should issue the correct amount of SetTokens", async () => {
      const initBalance = await setToken.balanceOf(subjectCaller.address);
      await subject();
      const finalBalance = await setToken.balanceOf(subjectCaller.address);

      expect(finalBalance.sub(initBalance)).to.eq(subjectSetAmount);
    });

    it("it should not leave any dust in the contract", async () => {
      await subject();

      const finalCEtherBalance = await cEther.balanceOf(leverageExchangeIssuance.address);
      const finalWethBalance = await setV2Setup.weth.balanceOf(leverageExchangeIssuance.address);
      const finalUsdcBalance = await setV2Setup.usdc.balanceOf(leverageExchangeIssuance.address);

      expect(finalCEtherBalance).to.eq(ZERO);
      expect(finalWethBalance).to.eq(ZERO);
      expect(finalUsdcBalance).to.eq(ZERO);
    });
  });
});