import "module-alias/register";

import { BigNumber } from "ethers";

import { Address } from "@utils/types";
import { Account, ForkedTokens } from "@utils/test/types";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";
import {
  cacheBeforeEach,
  getAaveV2Fixture,
  getAccounts,
  getCurveFixture,
  getForkedTokens,
  getRandomAccount,
  getSystemFixture,
  getWaffleExpect,
  initializeForkedTokens,
} from "@utils/test/index";

import { AaveV2AToken, AaveV2VariableDebtToken } from "@utils/contracts/aaveV2";
import { AaveV2Fixture, CurveFixture, SystemFixture } from "@utils/fixtures";
import {
  AaveLeverageModule,
  CurveExchangeAdapter,
  CurveStableswapMock,
  SetToken,
  DebtIssuanceModuleV2,
  ManagerIssuanceHookMock,
} from "@utils/contracts";

import { IERC20 } from "@typechain/IERC20";
import { EMPTY_BYTES, MAX_UINT_256, ZERO, ADDRESS_ZERO } from "@utils/constants";

const expect = getWaffleExpect();
/**
 * Tests the icETH rebalance flow.
 *
 * The icETH product is a composite product composed of:
 * 1. stETH
 * 2. WETH
 */
describe("CurveExchangeAdapter AaveLeverageModule integration [ @forked-mainnet ]", () => {
  let owner: Account;
  let manager: Account;

  let deployer: DeployHelper;

  let adapter: CurveExchangeAdapter;
  let adapterName: string;

  let setup: SystemFixture;
  let aaveSetup: AaveV2Fixture;
  let curveSetup: CurveFixture;
  let stableswap: CurveStableswapMock;
  let aaveLeverageModule: AaveLeverageModule;
  let tokens: ForkedTokens;

  let weth: IERC20;
  let steth: IERC20;
  let debtIssuanceModule: DebtIssuanceModuleV2;
  let mockPreIssuanceHook: ManagerIssuanceHookMock;

  let astETH: AaveV2AToken;
  let variableDebtWETH: AaveV2VariableDebtToken;

  let setToken: SetToken;
  let issueQuantity: BigNumber;

  cacheBeforeEach(async () => {
    [owner, manager] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setup = getSystemFixture(owner.address);
    await setup.initialize();

    // Setup ForkedTokens
    await initializeForkedTokens(deployer);
    tokens = getForkedTokens();
    weth = tokens.weth;
    steth = tokens.steth;

    // Setup Curve
    curveSetup = getCurveFixture(owner.address);
    stableswap = await curveSetup.getForkedWethStethCurveStableswapPool();

    adapter = await deployer.adapters.deployCurveExchangeAdapter(
      weth.address,
      steth.address,
      BigNumber.from(0),
      BigNumber.from(1),
      stableswap.address,
    );
    adapterName = "CurveExchangeAdapter";

    // Setup Aave with WETH:stETH at 1.01:1 price.
    aaveSetup = getAaveV2Fixture(owner.address);
    await aaveSetup.initialize(weth.address, steth.address, "commons", ether(1.02));

    // Configure borrow rate for stETH like WETH (see Aave fixture)
    const oneRay = BigNumber.from(10).pow(27);
    await aaveSetup.setMarketBorrowRate(steth.address, oneRay.mul(3).div(100));

    // Deploy DebtIssuanceModuleV2
    debtIssuanceModule = await deployer.modules.deployDebtIssuanceModuleV2(
      setup.controller.address,
    );

    await setup.controller.addModule(debtIssuanceModule.address);

    // Deploy mock issuance hook to pass as arg in DebtIssuance module initialization
    mockPreIssuanceHook = await deployer.mocks.deployManagerIssuanceHookMock();

    // Create liquidity
    const ape = await getRandomAccount(); // The wallet adding initial liquidity
    await weth.transfer(ape.address, ether(10000));
    await weth.connect(ape.wallet).approve(aaveSetup.lendingPool.address, MAX_UINT_256);
    await aaveSetup.lendingPool
      .connect(ape.wallet)
      .deposit(weth.address, ether(10000), ape.address, ZERO);

    await steth.transfer(ape.address, ether(10000));
    await steth.connect(ape.wallet).approve(aaveSetup.lendingPool.address, MAX_UINT_256);
    await aaveSetup.lendingPool
      .connect(ape.wallet)
      .deposit(steth.address, ether(10000), ape.address, ZERO);

    variableDebtWETH = aaveSetup.wethReserveTokens.variableDebtToken;

    // Alias astETH to dai in Aave Setup (stETH passed in as dai's position in aaveSetup.initialize);
    astETH = aaveSetup.daiReserveTokens.aToken;

    // Deploy AaveLeverageModule
    const aaveV2Library = await deployer.libraries.deployAaveV2();
    aaveLeverageModule = await deployer.modules.deployAaveLeverageModule(
      setup.controller.address,
      aaveSetup.lendingPoolAddressesProvider.address,
      "contracts/protocol/integration/lib/AaveV2.sol:AaveV2",
      aaveV2Library.address,
    );
    await setup.controller.addModule(aaveLeverageModule.address);

    // Add DebtIssuanceModule as valid integration for AaveLeverageModule
    await setup.integrationRegistry.addIntegration(
      aaveLeverageModule.address,
      "DefaultIssuanceModule",
      debtIssuanceModule.address,
    );

    // Add Curve adapter as valid integration for AaveLeverageModule
    await setup.integrationRegistry.addIntegration(
      aaveLeverageModule.address,
      adapterName,
      adapter.address,
    );
  });

  async function initialize() {
    // Create Set token
    setToken = await setup.createSetToken(
      [astETH.address],
      [ether(2)],
      [debtIssuanceModule.address, aaveLeverageModule.address],
      manager.address,
    );

    // Fund owner with stETH
    await tokens.steth.transfer(owner.address, ether(1100));
    // Fund owner with WETH
    await tokens.weth.transfer(owner.address, ether(1100));

    // stETH has balance rounding errors that crash DebtIssuanceModuleV2 with:
    //  "Invalid transfer in. Results in undercollateralization"
    // > transfer quantity =              1000000000000000000
    // > stETH balanceOf after transfer =  999999999999999999
    // Transfer steth to set token to overcollaterize the position by exactly the rounding error
    // Transferring 2 results in steth.balanceOf(setToken) == 1
    await tokens.steth.transfer(setToken.address, 2);

    // Approve tokens to DebtIssuanceModule and AaveLendingPool
    await astETH.connect(owner.wallet).approve(debtIssuanceModule.address, MAX_UINT_256);

    await weth.connect(owner.wallet).approve(debtIssuanceModule.address, MAX_UINT_256);

    await steth.connect(owner.wallet).approve(debtIssuanceModule.address, MAX_UINT_256);

    await weth.connect(owner.wallet).approve(aaveSetup.lendingPool.address, MAX_UINT_256);

    await steth.connect(owner.wallet).approve(aaveSetup.lendingPool.address, MAX_UINT_256);

    // Initialize debIssuance module
    await debtIssuanceModule.connect(manager.wallet).initialize(
      setToken.address,
      ether(0.1),
      ether(0), // No issue fee
      ether(0), // No redeem fee
      owner.address,
      mockPreIssuanceHook.address,
    );

    // Initialize SetToken on AaveModule
    await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);

    await aaveLeverageModule.connect(manager.wallet).initialize(
      setToken.address,
      [steth.address, weth.address], // Collateral Assets
      [weth.address, steth.address], // Borrow Assets
    );

    // Mint astETH
    await aaveSetup.lendingPool
      .connect(owner.wallet)
      .deposit(steth.address, ether(2), owner.address, ZERO);

    // Issue
    issueQuantity = ether(1);

    await debtIssuanceModule
      .connect(owner.wallet)
      .issue(setToken.address, issueQuantity, owner.address);
  }

  describe("#lever", async () => {
    // Deposit stETH as collateral in Aave (minting astETH)
    // Borrow WETH using deposited stETH as collateral
    // Swap WETH to stETH using the Curve stETH pool
    // Depost stETH as collateral in Aave (minting additional astETH);
    context("using CurveExchangeAdapter to trade stETH for WETH", async () => {
      let subjectBorrowAsset: Address;
      let subjectCollateralAsset: Address;
      let subjectBorrowQuantityUnits: BigNumber;
      let subjectMinReceiveQuantityUnits: BigNumber;
      let subjectAdapterName: string;
      let subjectSetToken: Address;
      let subjectData: string;
      let subjectCaller: Account;

      cacheBeforeEach(initialize);

      beforeEach(async () => {
        subjectBorrowAsset = weth.address;
        subjectCollateralAsset = steth.address;
        subjectBorrowQuantityUnits = ether(1);
        subjectMinReceiveQuantityUnits = ether(0.9);
        subjectAdapterName = adapterName;
        subjectSetToken = setToken.address;

        const tradeCalldata = await adapter.getTradeCalldata(
          subjectBorrowAsset,
          subjectCollateralAsset,
          subjectSetToken,
          subjectBorrowQuantityUnits,
          subjectMinReceiveQuantityUnits,
          EMPTY_BYTES,
        );
        subjectData = tradeCalldata[2];
        subjectCaller = manager;
      });

      async function subject(): Promise<any> {
        return aaveLeverageModule
          .connect(subjectCaller.wallet)
          .lever(
            subjectSetToken,
            subjectBorrowAsset,
            subjectCollateralAsset,
            subjectBorrowQuantityUnits,
            subjectMinReceiveQuantityUnits,
            subjectAdapterName,
            subjectData,
          );
      }

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // astETH position is increased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = currentPositions[0];

        const expectedFirstPositionUnitMin = initialPositions[0].unit.add(
          subjectMinReceiveQuantityUnits,
        );
        // We expect to receive more steth than we borrow for weth due to the exchange rate.
        // Therefore, if we borrow 1 WETH, we expect to get 1.02 STETH which gives us an extra
        // 1.02 astETH. Technically the exchange rate at this block number is something closer
        // to 1.0145 which vaguely matches the actual value we receive below.
        const expectedFirstPositionUnitMax = initialPositions[0].unit.add(
          subjectBorrowQuantityUnits.add(ether(0.07)),
        );

        expect(initialPositions.length).to.eq(1);
        expect(currentPositions.length).to.eq(2); // added a new borrow position
        expect(newFirstPosition.component).to.eq(astETH.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default

        // Min is: 2900000000000000000
        // Max is: 3020000000000000000
        // Actual value is: 3014553114053842195
        expect(newFirstPosition.unit).to.be.gt(expectedFirstPositionUnitMin);
        expect(newFirstPosition.unit).to.be.lt(expectedFirstPositionUnitMax);

        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];

        const expectedSecondPositionUnit = (await variableDebtWETH.balanceOf(setToken.address)).mul(
          -1,
        );

        expect(initialPositions.length).to.eq(1);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component.toLowerCase()).to.eq(weth.address.toLowerCase());
        expect(newSecondPosition.positionState).to.eq(1); // External
        expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
        expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
      });

      it("should transfer the correct components to the Stableswap", async () => {
        // We're Swapping WETH for stETH
        const oldSourceTokenBalance = await weth.balanceOf(stableswap.address);

        await subject();
        const totalSourceQuantity = subjectBorrowQuantityUnits;
        const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
        const newSourceTokenBalance = await weth.balanceOf(stableswap.address);
        expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
      });

      it("should transfer the correct components from the exchange", async () => {
        const oldDestinationTokenBalance = await steth.balanceOf(stableswap.address);

        await subject();
        const minDestinationQuantity = subjectMinReceiveQuantityUnits;
        // If we borrowed 1 WETH and exchanged for ~1.02 STETH from the exchange,
        // then we expect the balance of steth on the exchange to also decrease
        // by that same amount
        const maxDestinationQuantity = subjectBorrowQuantityUnits.add(ether(0.08));

        // Will be at most: oldBalance - minReceived
        // Will be at least: oldBalance - borrowQuantity
        const expectedMaxDestinationTokenBalance = oldDestinationTokenBalance.sub(
          minDestinationQuantity,
        );
        const expectedMinDestinationTokenBalance = oldDestinationTokenBalance.sub(
          maxDestinationQuantity,
        );

        const newDestinationTokenBalance = await steth.balanceOf(stableswap.address);

        expect(newDestinationTokenBalance).to.be.gt(expectedMinDestinationTokenBalance);
        expect(newDestinationTokenBalance).to.be.lt(expectedMaxDestinationTokenBalance);
      });

      it("should NOT leave any WETH or stETH in the trade adapter", async () => {
        const initialWETHAdapterBalance = await weth.balanceOf(adapter.address);
        const initialSTETHAdapterBalance = await steth.balanceOf(adapter.address);

        await subject();

        const finalWETHAdapterBalance = await weth.balanceOf(adapter.address);
        const finalSTETHAdapterBalance = await steth.balanceOf(adapter.address);

        expect(initialWETHAdapterBalance).eq(ZERO);
        expect(initialSTETHAdapterBalance).eq(ZERO);

        expect(finalWETHAdapterBalance).eq(ZERO);
        expect(finalSTETHAdapterBalance).eq(ZERO);
      });
    });
  });

  describe("#delever", async () => {
    context("using CurveExchangeAdapter to trade stETH for WETH", async () => {
      let subjectRepayAsset: Address;
      let subjectCollateralAsset: Address;
      let subjectRedeemQuantityUnits: BigNumber;
      let subjectMinRepayQuantityUnits: BigNumber;
      let subjectAdapterName: string;
      let subjectSetToken: Address;
      let subjectData: string;
      let subjectCaller: Account;

      cacheBeforeEach(initialize);

      // Lever up before delevering
      cacheBeforeEach(async () => {
        const tradeCalldata = await adapter.getTradeCalldata(
          weth.address,
          steth.address,
          setToken.address,
          ether(1),
          ether(1),
          EMPTY_BYTES,
        );
        const data = tradeCalldata[2];
        await aaveLeverageModule
          .connect(manager.wallet)
          .lever(
            setToken.address,
            weth.address,
            steth.address,
            ether(1),
            ether(1),
            adapterName,
            data,
          );
      });

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectCollateralAsset = steth.address;
        subjectRepayAsset = weth.address;

        subjectRedeemQuantityUnits = ether(1.06645);
        subjectMinRepayQuantityUnits = ether(1);
        subjectAdapterName = adapterName;

        const tradeCalldata = await adapter.getTradeCalldata(
          subjectCollateralAsset,
          subjectRepayAsset,
          subjectSetToken,
          subjectRedeemQuantityUnits,
          subjectMinRepayQuantityUnits,
          EMPTY_BYTES,
        );
        subjectData = tradeCalldata[2];
        subjectCaller = manager;
      });

      async function subject(): Promise<any> {
        return aaveLeverageModule
          .connect(subjectCaller.wallet)
          .delever(
            subjectSetToken,
            subjectCollateralAsset,
            subjectRepayAsset,
            subjectRedeemQuantityUnits,
            subjectMinRepayQuantityUnits,
            subjectAdapterName,
            subjectData,
          );
      }

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        // Get expected aTokens burnt
        const expectedFirstPositionUnit = initialPositions[0].unit.sub(subjectRedeemQuantityUnits);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(astETH.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default

        expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);

        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        const currentPositions = await setToken.getPositions();
        const newSecondPosition = currentPositions[1];

        const expectedSecondPositionUnit = (await variableDebtWETH.balanceOf(setToken.address)).mul(
          -1,
        );

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component.toLowerCase()).to.eq(weth.address.toLowerCase());
        expect(newSecondPosition.positionState).to.eq(0); // Pay everything back

        // Due to exchange rates in Curve Pool, there's a tiny bit of WETH left in the set token when redeeming
        // with the current parameters as they are not 1:1. Actual WETH left in the Set = 64_546_225_787_308_765.
        // So around 0.000019 ETH
        expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit.add(BigNumber.from("64546225787308765")));
        expect(newSecondPosition.unit.div(ether(0.0001))).to.closeTo(expectedSecondPositionUnit, 645);
        expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should transfer the correct components to the Stableswap", async () => {
        // We're swapping stETH for ETH
        const oldDestinationTokenBalance = await steth.balanceOf(stableswap.address);

        await subject();

        const expectedDestinationTokenBalance = oldDestinationTokenBalance.add(
          subjectRedeemQuantityUnits,
        );

        const newDestinationTokenBalance = await steth.balanceOf(stableswap.address);

        // Accomodate rounding error of 1 when reading stETH balance
        expect(newDestinationTokenBalance).to.be.closeTo(expectedDestinationTokenBalance, 1);
      });

      it("should transfer the correct components from the exchange", async () => {
        const oldSourceTokenBalance = await weth.balanceOf(stableswap.address);

        await subject();

        const minSourceQuantity = subjectMinRepayQuantityUnits;
        const maxSourceQuantity = subjectRedeemQuantityUnits;

        // Will be at least: oldBalance + redeemQuantity
        // Will be at most: oldBalance + minRepayQuantity
        const expectedMaxSourceTokenBalance = oldSourceTokenBalance.sub(minSourceQuantity);
        const expectedMinSourceTokenBalance = oldSourceTokenBalance.sub(maxSourceQuantity);

        const newSourceTokenBalance = await weth.balanceOf(stableswap.address);

        expect(newSourceTokenBalance).to.be.gt(expectedMinSourceTokenBalance);
        expect(newSourceTokenBalance).to.be.lt(expectedMaxSourceTokenBalance);
      });

      it("should NOT leave any WETH or stETH in the trade adapter", async () => {
        const initialWETHAdapterBalance = await weth.balanceOf(adapter.address);
        const initialSTETHAdapterBalance = await steth.balanceOf(adapter.address);

        await subject();

        const finalWETHAdapterBalance = await weth.balanceOf(adapter.address);
        const finalSTETHAdapterBalance = await steth.balanceOf(adapter.address);

        expect(initialWETHAdapterBalance).eq(ZERO);
        expect(initialSTETHAdapterBalance).eq(ZERO);

        expect(finalWETHAdapterBalance).eq(ZERO);
        expect(finalSTETHAdapterBalance).eq(ZERO);
      });
    });
  });
});
