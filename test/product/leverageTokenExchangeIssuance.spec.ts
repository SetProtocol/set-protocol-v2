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
  bitcoin,
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
import { defaultAbiCoder } from "ethers/lib/utils";

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
  let setTokenWbtc: SetToken;
  let cEther: CEther;
  let cUSDC: CERc20;
  let cWBTC: CERc20;

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
    await setV2Setup.wbtc.approve(uniswapSetup.router.address, MAX_UINT_256);
    await setV2Setup.dai.approve(uniswapSetup.router.address, MAX_UINT_256);

    await uniswapSetup.router.addLiquidity(
      setV2Setup.weth.address,
      setV2Setup.dai.address,
      ether(100),
      ether(200000),
      0,
      0,
      owner.address,
      MAX_UINT_256
    );

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

    await uniswapSetup.router.addLiquidity(
      setV2Setup.weth.address,
      setV2Setup.wbtc.address,
      ether(1500),
      bitcoin(100),
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

    cWBTC = await compoundSetup.createAndEnableCToken(
      setV2Setup.wbtc.address,
      ether(0.02),
      compoundSetup.comptroller.address,
      compoundSetup.interestRateModel.address,
      "Compound WBTC",
      "cWBTC",
      8,
      ether(0.75),
      ether(300000000000000) // $30,000
    );

    await compoundSetup.comptroller._setCompRate(ether(1));
    await compoundSetup.comptroller._addCompMarkets([cEther.address, cUSDC.address, cWBTC.address]);

    // Mint cTokens
    await setV2Setup.usdc.approve(cUSDC.address, MAX_UINT_256);
    await cUSDC.mint(ether(1));
    await setV2Setup.wbtc.approve(cWBTC.address, MAX_UINT_256);
    await cWBTC.mint(bitcoin(1));
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

    // Deploy Set Tokens
    setToken = await setV2Setup.createSetToken(
      [cEther.address],
      [ether("0.000000005")],
      [compoundLeverageModule.address, debtIssuanceModule.address]
    );

    setTokenWbtc = await setV2Setup.createSetToken(
      [cWBTC.address],
      [ether("0.000000005")],
      [compoundLeverageModule.address, debtIssuanceModule.address]
    );

    // initialize modules
    managerIssuanceHook = await deployer.mocks.deployManagerIssuanceHookMock();
    await debtIssuanceModule.initialize(setToken.address, 0, 0, 0, owner.address, managerIssuanceHook.address);
    await debtIssuanceModule.initialize(setTokenWbtc.address, 0, 0, 0, owner.address, managerIssuanceHook.address);

    await compoundLeverageModule.updateAllowedSetToken(setToken.address, true);
    await compoundLeverageModule.initialize(
      setToken.address,
      [setV2Setup.weth.address],
      [setV2Setup.usdc.address],
    );

    await compoundLeverageModule.updateAllowedSetToken(setTokenWbtc.address, true);
    await compoundLeverageModule.initialize(
      setTokenWbtc.address,
      [setV2Setup.wbtc.address],
      [setV2Setup.usdc.address],
    );

    // issue some sets
    await cEther.approve(debtIssuanceModule.address, MAX_UINT_256);
    await debtIssuanceModule.issue(setToken.address, ether(1), owner.address);

    await cWBTC.approve(debtIssuanceModule.address, MAX_UINT_256);
    await debtIssuanceModule.issue(setTokenWbtc.address, ether(1), owner.address);

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

    await compoundLeverageModule.lever(
      setTokenWbtc.address,
      setV2Setup.usdc.address,
      setV2Setup.wbtc.address,
      usdc(15000),
      0,
      "UniswapTradeAdapter",
      defaultAbiCoder.encode(["address[]"], [[setV2Setup.usdc.address, setV2Setup.weth.address, setV2Setup.wbtc.address]])
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
      subjectSetAmount = ether(1);
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
      const finalSetBalance = await subjectSetToken.balanceOf(leverageExchangeIssuance.address);

      expect(finalCEtherBalance).to.eq(ZERO);
      expect(finalWethBalance).to.eq(ZERO);
      expect(finalUsdcBalance).to.eq(ZERO);
      expect(finalSetBalance).to.eq(ZERO);
    });

    context("when issuing a set token with a cErc20 collateral", async () => {
      beforeEach(async () => {
        subjectSetToken = setTokenWbtc;
        subjectInputToken = setV2Setup.wbtc.address;
        subjectDebtPath = [setV2Setup.usdc.address, setV2Setup.weth.address, setV2Setup.wbtc.address];

        // prep trader
        await setV2Setup.wbtc.transfer(subjectCaller.address, bitcoin(1000));
        await setV2Setup.wbtc.connect(subjectCaller.wallet).approve(leverageExchangeIssuance.address, MAX_UINT_256);

        // add funds to flash loan mock
        await setV2Setup.wbtc.transfer(flashLoanMock.address, bitcoin(1000));
      });

      it("it should issue the correct amount of SetTokens", async () => {
        const initBalance = await setTokenWbtc.balanceOf(subjectCaller.address);
        await subject();
        const finalBalance = await setTokenWbtc.balanceOf(subjectCaller.address);

        expect(finalBalance.sub(initBalance)).to.eq(subjectSetAmount);
      });

      it("it should not leave any dust in the contract", async () => {
        await subject();

        const finalCWBTCBalance = await cWBTC.balanceOf(leverageExchangeIssuance.address);
        const finalWethBalance = await setV2Setup.weth.balanceOf(leverageExchangeIssuance.address);
        const finalUsdcBalance = await setV2Setup.usdc.balanceOf(leverageExchangeIssuance.address);
        const finalSetBalance = await subjectSetToken.balanceOf(leverageExchangeIssuance.address);

        expect(finalCWBTCBalance).to.eq(ZERO);
        expect(finalWethBalance).to.eq(ZERO);
        expect(finalUsdcBalance).to.eq(ZERO);
        expect(finalSetBalance).to.eq(ZERO);
      });
    });

    context("when input token is not the collateral underlying", async () => {
      beforeEach(async () => {
        subjectInputToken = setV2Setup.dai.address;
        subjectInputRouter = uniswapSetup.router.address;
        subjectInputPath = [setV2Setup.dai.address, setV2Setup.weth.address];

        // prep trader
        await setV2Setup.dai.transfer(subjectCaller.address, ether(200000));
        await setV2Setup.dai.connect(subjectCaller.wallet).approve(leverageExchangeIssuance.address, MAX_UINT_256);
      });

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
        const finalDaiBalance = await setV2Setup.dai.balanceOf(leverageExchangeIssuance.address);
        const finalSetBalance = await subjectSetToken.balanceOf(leverageExchangeIssuance.address);

        expect(finalCEtherBalance).to.eq(ZERO);
        expect(finalWethBalance).to.eq(ZERO);
        expect(finalUsdcBalance).to.eq(ZERO);
        expect(finalDaiBalance).to.eq(ZERO);
        expect(finalSetBalance).to.eq(ZERO);
      });
    });
  });

  describe("#redeemExactInput", async () => {

    let subjectCaller: Account;
    let subjectSetToken: SetToken;
    let subjectSetAmount: BigNumber;
    let subjectMinOut: BigNumber;
    let subjectOutputToken: Address;
    let subjectOutputRouter: Address;
    let subjectOutputPath: Address[];
    let subjectDebtRouter: Address;
    let subjectDebtPath: Address[];

    beforeEach(async () => {

      subjectCaller = user;
      subjectSetToken = setToken;
      subjectSetAmount = ether(1);
      subjectMinOut = ZERO;
      subjectOutputToken = setV2Setup.weth.address;
      subjectOutputRouter = uniswapSetup.router.address;
      subjectOutputPath = [];
      subjectDebtRouter = uniswapSetup.router.address;
      subjectDebtPath = [setV2Setup.weth.address, setV2Setup.usdc.address];

      // prep trader
      await subjectSetToken.transfer(subjectCaller.address, subjectSetAmount);
      await subjectSetToken.connect(subjectCaller.wallet).approve(leverageExchangeIssuance.address, MAX_UINT_256);

      // add funds to flash loan mock
      await setV2Setup.usdc.transfer(flashLoanMock.address, usdc(100000));
    });

    async function subject(): Promise<void> {
      await leverageExchangeIssuance.connect(subjectCaller.wallet).redeemExactInput(
        subjectSetToken.address,
        subjectSetAmount,
        subjectMinOut,
        subjectOutputToken,
        subjectOutputRouter,
        subjectOutputPath,
        subjectDebtRouter,
        subjectDebtPath
      );
    }

    it("it should redeem the correct amount of SetTokens", async () => {
      const initBalance = await setToken.balanceOf(subjectCaller.address);
      await subject();
      const finalBalance = await setToken.balanceOf(subjectCaller.address);

      expect(initBalance.sub(finalBalance)).to.eq(subjectSetAmount);
    });

    it("it should not leave any dust in the contract", async () => {
      await subject();

      const finalCEtherBalance = await cEther.balanceOf(leverageExchangeIssuance.address);
      const finalWethBalance = await setV2Setup.weth.balanceOf(leverageExchangeIssuance.address);
      const finalUsdcBalance = await setV2Setup.usdc.balanceOf(leverageExchangeIssuance.address);
      const finalSetBalance = await subjectSetToken.balanceOf(leverageExchangeIssuance.address);

      expect(finalCEtherBalance).to.eq(ZERO);
      expect(finalWethBalance).to.eq(ZERO);
      expect(finalUsdcBalance).to.eq(ZERO);
      expect(finalSetBalance).to.eq(ZERO);
    });

    context("when redeeming a set token with a cErc20 collateral", async () => {
      beforeEach(async () => {
        subjectSetToken = setTokenWbtc;
        subjectOutputToken = setV2Setup.wbtc.address;
        subjectDebtPath = [setV2Setup.wbtc.address, setV2Setup.weth.address, setV2Setup.usdc.address];

        // prep trader
        await setTokenWbtc.transfer(subjectCaller.address, ether(1));
        await setTokenWbtc.connect(subjectCaller.wallet).approve(leverageExchangeIssuance.address, MAX_UINT_256);

        // add funds to flash loan mock
        await setV2Setup.usdc.transfer(flashLoanMock.address, usdc(10000));
      });

      it("it should redeem the correct amount of SetTokens", async () => {
        const initBalance = await setTokenWbtc.balanceOf(subjectCaller.address);
        await subject();
        const finalBalance = await setTokenWbtc.balanceOf(subjectCaller.address);

        expect(initBalance.sub(finalBalance)).to.eq(subjectSetAmount);
      });

      it("it should not leave any dust in the contract", async () => {
        await subject();

        const finalCWBTCBalance = await cWBTC.balanceOf(leverageExchangeIssuance.address);
        const finalWethBalance = await setV2Setup.weth.balanceOf(leverageExchangeIssuance.address);
        const finalUsdcBalance = await setV2Setup.usdc.balanceOf(leverageExchangeIssuance.address);
        const finalSetBalance = await subjectSetToken.balanceOf(leverageExchangeIssuance.address);

        expect(finalCWBTCBalance).to.eq(ZERO);
        expect(finalWethBalance).to.eq(ZERO);
        expect(finalUsdcBalance).to.eq(ZERO);
        expect(finalSetBalance).to.eq(ZERO);
      });
    });

    context("when output token is not the collateral underlying", async () => {
      beforeEach(async () => {
        subjectOutputToken = setV2Setup.dai.address;
        subjectOutputRouter = uniswapSetup.router.address;
        subjectOutputPath = [setV2Setup.weth.address, setV2Setup.dai.address];

        // prep trader
        await setV2Setup.dai.transfer(subjectCaller.address, ether(200000));
        await setV2Setup.dai.connect(subjectCaller.wallet).approve(leverageExchangeIssuance.address, MAX_UINT_256);
      });

      it("it should redeem the correct amount of SetTokens", async () => {
        const initBalance = await setToken.balanceOf(subjectCaller.address);
        await subject();
        const finalBalance = await setToken.balanceOf(subjectCaller.address);

        expect(initBalance.sub(finalBalance)).to.eq(subjectSetAmount);
      });

      it("it should not leave any dust in the contract", async () => {
        await subject();

        const finalCEtherBalance = await cEther.balanceOf(leverageExchangeIssuance.address);
        const finalWethBalance = await setV2Setup.weth.balanceOf(leverageExchangeIssuance.address);
        const finalUsdcBalance = await setV2Setup.usdc.balanceOf(leverageExchangeIssuance.address);
        const finalDaiBalance = await setV2Setup.dai.balanceOf(leverageExchangeIssuance.address);
        const finalSetBalance = await subjectSetToken.balanceOf(leverageExchangeIssuance.address);

        expect(finalCEtherBalance).to.eq(ZERO);
        expect(finalWethBalance).to.eq(ZERO);
        expect(finalUsdcBalance).to.eq(ZERO);
        expect(finalDaiBalance).to.eq(ZERO);
        expect(finalSetBalance).to.eq(ZERO);
      });
    });
  });
});