import "module-alias/register";
import { ContractTransaction } from "ethers";
import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  AaveV2,
  AaveLeverageModule,
  DebtIssuanceModuleV2,
  SetToken,
  UniswapV2ExchangeAdapter,
} from "@utils/contracts";
import {
  AaveV2AToken,
  AaveV2VariableDebtToken
} from "@utils/contracts/aaveV2";
import DeployHelper from "@utils/deploys";
import {
  bitcoin,
  ether,
  usdc,
  preciseDiv,
  preciseMul,
  preciseMulCeil,
  preciseDivCeil
} from "@utils/index";
import {
  cacheBeforeEach,
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  getAaveV2Fixture,
  getUniswapFixture
} from "@utils/test/index";
import { AaveV2Fixture, SystemFixture, UniswapFixture } from "@utils/fixtures";
import { BigNumber } from "ethers";
import { ADDRESS_ZERO, ZERO, EMPTY_BYTES, MAX_UINT_256 } from "@utils/constants";

const expect = getWaffleExpect();

// Due to low utilization rate of the reserves and small principal amounts, the interest rate accrued each block is very small.
// Hence, accrued interest doesn't reflect immediately in tokens which have less precision, i.e. less number of decimal places.
// Eg. if interest accrued each block for an asset is 100 wei (1 wei = 10^(-18)), then USDC (6 decimal places) and
// WBTC (8 decimal places) would not register this increase until a couple of blocks, whereas DAI (18 decimal places) and
// WETH (18 decimal places) balances would register this increase in the immediate next block. Thus, we use WBTC and USDC as much
// as possible to avoid having to write the complex interest accrual logic of Aave to determine the interest rate accrued each block.
// For WETH and DAI, we use looser comparison checks implemented in the `expectGreaterThanOrEqualToWithUpperBound` helper function
// to account for the small amount of interest accrued.

/**
 * Checks for |val2| <= |val1| < |val2| * 1.000001
 *
 * @param val1 Value 1 with accrued interest
 * @param val2 Value 2
 */
async function expectGreaterThanOrEqualToWithUpperBound(val1: BigNumber, val2: BigNumber): Promise<any> {
  const oneMil = BigNumber.from(10).pow(6);
  await expect(val1.abs()).to.be.gte(val2.abs());                                 // |val1| >= |val2|
  await expect(val1.abs()).to.be.lt(val2.abs().mul(oneMil.add(1)).div(oneMil));   // |val1| <  |val2| * 1.000001
}

describe("AaveUniswapLeverageDebtIssuance", () => {
  let owner: Account;
  let feeRecipient: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;
  let aaveV2Setup: AaveV2Fixture;
  let uniswapSetup: UniswapFixture;

  let aaveV2Library: AaveV2;
  let aaveLeverageModule: AaveLeverageModule;
  let debtIssuanceModule: DebtIssuanceModuleV2;
  let uniswapExchangeAdapter: UniswapV2ExchangeAdapter;

  let aWBTC: AaveV2AToken;
  let variableDebtDAI: AaveV2VariableDebtToken;
  let variableDebtUSDC: AaveV2VariableDebtToken;

  cacheBeforeEach(async () => {
    [
      owner,
      feeRecipient,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setup = getSystemFixture(owner.address);
    await setup.initialize();

    uniswapSetup = getUniswapFixture(owner.address);
    await uniswapSetup.initialize(owner, setup.weth.address, setup.wbtc.address, setup.dai.address);

    aaveV2Setup = getAaveV2Fixture(owner.address);
    await aaveV2Setup.initialize(setup.weth.address, setup.dai.address);


    // Create a WBTC reserve
    const wbtcReserveTokens = await aaveV2Setup.createAndEnableReserve(
      setup.wbtc.address, "WBTC", BigNumber.from(8),
      BigNumber.from(8000),   // base LTV: 80%
      BigNumber.from(8250),   // liquidation threshold: 82.5%
      BigNumber.from(10500),  // liquidation bonus: 105.00%
      BigNumber.from(1000),   // reserve factor: 10%
      true,                   // enable borrowing on reserve
      true                    // enable stable debts
    );

    // Create an USDC reserve
    const usdcReserveTokens = await aaveV2Setup.createAndEnableReserve(
      setup.usdc.address, "USDC", BigNumber.from(6),
      BigNumber.from(8000),   // base LTV: 80%
      BigNumber.from(8250),   // liquidation threshold: 82.5%
      BigNumber.from(10500),  // liquidation bonus: 105.00%
      BigNumber.from(1000),   // reserve factor: 10%
      true,                   // enable borrowing on reserve
      true                    // enable stable debts
    );

    await aaveV2Setup.setAssetPriceInOracle(setup.wbtc.address, ether(1));  // Set to 1 ETH
    await aaveV2Setup.setAssetPriceInOracle(setup.usdc.address, ether(0.001)); // Set to $1000 ETH

    // Mint aTokens on Aave
    await setup.wbtc.approve(aaveV2Setup.lendingPool.address, bitcoin(1000));
    await aaveV2Setup.lendingPool.deposit(
      setup.wbtc.address,
      bitcoin(1000),
      owner.address,
      ZERO
    );
    await setup.dai.approve(aaveV2Setup.lendingPool.address, ether(50000));
    await aaveV2Setup.lendingPool.deposit(
      setup.dai.address,
      ether(50000),
      owner.address,
      ZERO
    );
    await setup.usdc.approve(aaveV2Setup.lendingPool.address, usdc(50000));
    await aaveV2Setup.lendingPool.deposit(
      setup.usdc.address,
      usdc(50000),
      owner.address,
      ZERO
    );

    aWBTC = wbtcReserveTokens.aToken;

    variableDebtUSDC = usdcReserveTokens.variableDebtToken;
    variableDebtDAI = aaveV2Setup.daiReserveTokens.variableDebtToken;

    // Create WBTC USDC pool and pool liquidity
    await uniswapSetup.createNewPair(setup.wbtc.address, setup.usdc.address);
    await setup.usdc.connect(owner.wallet).approve(uniswapSetup.router.address, MAX_UINT_256);
    await setup.wbtc.connect(owner.wallet).approve(uniswapSetup.router.address, MAX_UINT_256);
    await setup.dai.connect(owner.wallet).approve(uniswapSetup.router.address, MAX_UINT_256);

    // 100 WBTC = 100k USDC. 1 WBTC = 1000 USDC
    await uniswapSetup.router.connect(owner.wallet).addLiquidity(
      setup.wbtc.address,
      setup.usdc.address,
      bitcoin(100),
      usdc(100000),
      bitcoin(100),
      usdc(100000),
      owner.address,
      MAX_UINT_256
    );

    // 100 WBTC = 100k DAI. 1 WBTC = 1000 DAI
    await uniswapSetup.router.connect(owner.wallet).addLiquidity(
      setup.wbtc.address,
      setup.dai.address,
      bitcoin(100),
      ether(100000),
      bitcoin(100),
      ether(100000),
      owner.address,
      MAX_UINT_256
    );

    debtIssuanceModule = await deployer.modules.deployDebtIssuanceModuleV2(setup.controller.address);
    await setup.controller.addModule(debtIssuanceModule.address);

    aaveV2Library = await deployer.libraries.deployAaveV2();
    aaveLeverageModule = await deployer.modules.deployAaveLeverageModule(
      setup.controller.address,
      aaveV2Setup.lendingPoolAddressesProvider.address,
      "contracts/protocol/integration/lib/AaveV2.sol:AaveV2",
      aaveV2Library.address,
    );
    await setup.controller.addModule(aaveLeverageModule.address);

    // Deploy Uniswap exchange adapter
    uniswapExchangeAdapter = await deployer.adapters.deployUniswapV2ExchangeAdapter(uniswapSetup.router.address);

    await setup.integrationRegistry.addIntegration(
      aaveLeverageModule.address,
      "UniswapV2ExchangeAdapter",
      uniswapExchangeAdapter.address
    );

    // Add debt issuance address to integration
    await setup.integrationRegistry.addIntegration(
      aaveLeverageModule.address,
      "DefaultIssuanceModule",
      debtIssuanceModule.address
    );
  });

  describe("#issuance", async () => {
    let setToken: SetToken;
    let issueFee: BigNumber;
    let aWBTCUnits: BigNumber;
    let actualSeizedTokens: BigNumber;

    let subjectSetToken: Address;
    let subjectQuantity: BigNumber;
    let subjectTo: Address;
    let subjectCaller: Account;
    let issueQuantity: BigNumber;

    async function subject(): Promise<ContractTransaction> {
      return debtIssuanceModule.connect(subjectCaller.wallet).issue(
        subjectSetToken,
        subjectQuantity,
        subjectTo,
      );
    }

    context("when a default aToken position with 0 supply", async () => {
      cacheBeforeEach(async () => {
        // Borrow some WETH to ensure the aWETH balance increases due to interest
        await aaveV2Setup.lendingPool.borrow(setup.wbtc.address, bitcoin(10), 2, ZERO, owner.address);

        aWBTCUnits = bitcoin(1);
        setToken = await setup.createSetToken(
          [aWBTC.address],
          [aWBTCUnits],
          [aaveLeverageModule.address, debtIssuanceModule.address]
        );
        issueFee = ether(0.005);
        await debtIssuanceModule.initialize(
          setToken.address,
          ether(0.02),
          issueFee,
          ether(0.005),
          feeRecipient.address,
          ADDRESS_ZERO
        );
        // Add SetToken to allow list
        await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
        await aaveLeverageModule.initialize(
          setToken.address,
          [setup.wbtc.address],
          [setup.usdc.address]
        );

        // Approve tokens to issuance module and call issue
        await aWBTC.approve(debtIssuanceModule.address, bitcoin(1000));

        // Issue 1 SetToken
        issueQuantity = ether(1);
      });

      beforeEach(() => {
        subjectSetToken = setToken.address;
        subjectQuantity = issueQuantity;
        subjectTo = owner.address;
        subjectCaller = owner;
      });

      it("should not update the collateral position on the SetToken", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        expect(initialPositions.length).to.eq(1);
        expect(currentPositions.length).to.eq(1);
        expect(newFirstPosition.component).to.eq(aWBTC.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(aWBTCUnits);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should not have a borrow position", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        const currentPositions = await setToken.getPositions();

        expect(initialPositions.length).to.eq(1);
        expect(currentPositions.length).to.eq(1);
      });

      it("should have the correct token balances", async () => {
        const preMinterAWBTCBalance = await aWBTC.balanceOf(subjectCaller.address);
        const preSetAWBTCBalance = await aWBTC.balanceOf(subjectSetToken);
        const preMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const preSetUsdcBalance = await setup.usdc.balanceOf(subjectSetToken);

        await subject();

        const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
        const usdcFlows = preciseMulCeil(mintQuantity, ZERO);
        const aWBTCFlows = preciseMul(mintQuantity, aWBTCUnits);

        const postMinterAWBTCBalance = await aWBTC.balanceOf(subjectCaller.address);
        const postSetAWBTCBalance = await aWBTC.balanceOf(subjectSetToken);
        const postMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const postSetUsdcBalance = await setup.usdc.balanceOf(subjectSetToken);

        // Note: Due to 1 aToken = 1 underlying and interest accruing every block, it is difficult to track precise
        // balances without replicating interest rate logic. Therefore, we expect actual balances to be greater
        // than expected due to interest accruals on aWBTC
        expect(postMinterAWBTCBalance).to.eq(preMinterAWBTCBalance.sub(aWBTCFlows));
        expect(postSetAWBTCBalance).to.eq(preSetAWBTCBalance.add(aWBTCFlows));
        expect(postMinterUsdcBalance).to.eq(preMinterUsdcBalance.add(usdcFlows)); // No debt
        expect(postSetUsdcBalance).to.eq(preSetUsdcBalance); // No debt
      });
    });

    context("when a default aToken position and external borrow position", async () => {
      cacheBeforeEach(async () => {
        // Borrow some WBTC to ensure the aWBTC balance increases due to interest
        await aaveV2Setup.lendingPool.borrow(setup.wbtc.address, bitcoin(10), 2, ZERO, owner.address);

        aWBTCUnits = bitcoin(1);
        setToken = await setup.createSetToken(
          [aWBTC.address],
          [aWBTCUnits],
          [aaveLeverageModule.address, debtIssuanceModule.address]
        );
        issueFee = ether(0.005);
        await debtIssuanceModule.initialize(
          setToken.address,
          ether(0.02),
          issueFee,
          ether(0.005),
          feeRecipient.address,
          ADDRESS_ZERO
        );
        // Add SetToken to allow list
        await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
        await aaveLeverageModule.initialize(
          setToken.address,
          [setup.wbtc.address],
          [setup.usdc.address]
        );

        // Approve tokens to issuance module and call issue
        await aWBTC.approve(debtIssuanceModule.address, bitcoin(1000));

        // Issue 1 SetToken
        issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Lever up
        await aaveLeverageModule.lever(
          setToken.address,
          setup.usdc.address,
          setup.wbtc.address,
          usdc(500),
          bitcoin(0.4),
          "UniswapV2ExchangeAdapter",
          EMPTY_BYTES
        );
      });

      beforeEach(() => {
        subjectSetToken = setToken.address;
        subjectQuantity = issueQuantity;
        subjectTo = owner.address;
        subjectCaller = owner;
      });

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // aWBTC position is increased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(aWBTC.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(initialPositions[0].unit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();
        const previousSecondPositionBalance = await variableDebtUSDC.balanceOf(setToken.address);
        const setTotalSupply = await setToken.totalSupply();

        await subject();

        const expectedSecondPositionUnit = preciseDivCeil(previousSecondPositionBalance, setTotalSupply).mul(-1);
        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component).to.eq(setup.usdc.address);
        expect(newSecondPosition.positionState).to.eq(1); // External
        expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
        expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
      });

      it("should have the correct token balances", async () => {
        const preMinterAWBTCBalance = await aWBTC.balanceOf(subjectCaller.address);
        const preSetAWBTCBalance = await aWBTC.balanceOf(subjectSetToken);
        const preMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const preSetUsdcDebtBalance = await variableDebtUSDC.balanceOf(subjectSetToken);

        const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
        const newAWBTCPositionUnits = (await setToken.getPositions())[0].unit;
        const aWBTCFlows = preciseMulCeil(mintQuantity, newAWBTCPositionUnits);

        await subject();

        const debtPositionUnits = (await setToken.getPositions())[1].unit;
        const usdcFlows = preciseMul(mintQuantity, debtPositionUnits).mul(-1);

        const postMinterAWBTCBalance = await aWBTC.balanceOf(subjectCaller.address);
        const postSetAWBTCBalance = await aWBTC.balanceOf(subjectSetToken);
        const postMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const postSetUsdcDebtBalance = await variableDebtUSDC.balanceOf(subjectSetToken);

        expect(postMinterAWBTCBalance).to.eq(preMinterAWBTCBalance.sub(aWBTCFlows));
        expect(postSetAWBTCBalance).to.eq(preSetAWBTCBalance.add(aWBTCFlows));
        expect(postMinterUsdcBalance).to.eq(preMinterUsdcBalance.add(usdcFlows));
        expect(postSetUsdcDebtBalance).to.eq(preSetUsdcDebtBalance.add(usdcFlows));
      });
    });

    context("when a default aToken position and liquidated borrow position", async () => {
      cacheBeforeEach(async () => {
        // Borrow some WBTC to ensure the aWBTC balance increases due to interest
        await aaveV2Setup.lendingPool.borrow(setup.wbtc.address, bitcoin(10), 2, ZERO, owner.address);

        aWBTCUnits = bitcoin(1);
        setToken = await setup.createSetToken(
          [aWBTC.address],
          [aWBTCUnits],
          [aaveLeverageModule.address, debtIssuanceModule.address]
        );
        issueFee = ether(0.005);
        await debtIssuanceModule.initialize(
          setToken.address,
          ether(0.02),
          issueFee,
          ether(0.005),
          feeRecipient.address,
          ADDRESS_ZERO
        );
        // Add SetToken to allow list
        await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
        await aaveLeverageModule.initialize(
          setToken.address,
          [setup.wbtc.address],
          [setup.usdc.address]
        );

        // Approve tokens to issuance module and call issue
        await aWBTC.approve(debtIssuanceModule.address, bitcoin(1000));

        // Issue 1 SetToken
        issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Lever up
        await aaveLeverageModule.lever(
          setToken.address,
          setup.usdc.address,
          setup.wbtc.address,
          usdc(750),
          bitcoin(0.5),
          "UniswapV2ExchangeAdapter",
          EMPTY_BYTES
        );

        // ETH decreases to $400. 1 WBTC = 1 WETH. So, WBTC = 400$.
        const liquidationUsdcPriceInEth = ether(0.0025);    // 1/400 = 0.0025
        await aaveV2Setup.setAssetPriceInOracle(setup.usdc.address, liquidationUsdcPriceInEth);

        // Liquidate 200 USDC
        const debtToCoverHumanReadable = 200;
        actualSeizedTokens = preciseMul(
          preciseMul(liquidationUsdcPriceInEth, ether(debtToCoverHumanReadable)),
          bitcoin(1.05)  // 5% liquidation bonus as configured in fixture
        );
        const debtToCover = usdc(debtToCoverHumanReadable);
        await setup.usdc.approve(aaveV2Setup.lendingPool.address, ether(250));

        await aaveV2Setup.lendingPool.connect(owner.wallet).liquidationCall(
          setup.wbtc.address,
          setup.usdc.address,
          setToken.address,
          debtToCover,
          true
        );

        // WBTC increases to $1000 to allow more borrow
        await aaveV2Setup.setAssetPriceInOracle(setup.usdc.address, ether(0.001));  // 1/1000 = .001
      });

      beforeEach(() => {
        subjectSetToken = setToken.address;
        subjectQuantity = issueQuantity;
        subjectTo = owner.address;
        subjectCaller = owner;
      });

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();
        const setTotalSupply = await setToken.totalSupply();

        await subject();

        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        // aWBTC position has decreased
        const expectedPostLiquidationUnit = initialPositions[0].unit.sub(preciseDivCeil(actualSeizedTokens, setTotalSupply));

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(aWBTC.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(expectedPostLiquidationUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        // Get debt balance after some amount of debt is paid during liquidation
        const previousSecondPositionBalance = await variableDebtUSDC.balanceOf(setToken.address);
        const setTotalSupply = await setToken.totalSupply();
        const expectedSecondPositionUnit = preciseDiv(previousSecondPositionBalance, setTotalSupply).mul(-1);

        await subject();

        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component).to.eq(setup.usdc.address);
        expect(newSecondPosition.positionState).to.eq(1); // External
        // We have used previousSecondPositionBalance to calculate the expectedSecondPositionUnit
        // but some debt accrued in the block in which we issued the Set.
        // The accrued interest was synced to the SetToken position units during issuance which leads to the absolute
        // value of newSecondPosition.unit to be greater than expectedSecondPositionUnit by a very small amount
        await expectGreaterThanOrEqualToWithUpperBound(newSecondPosition.unit, expectedSecondPositionUnit);
        expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
      });

      it("should have the correct token balances", async () => {
        const preMinterAWBTCBalance = await aWBTC.balanceOf(subjectCaller.address);
        const preSetAWBTCBalance = await aWBTC.balanceOf(subjectSetToken);
        const preMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const preSetUsdcDebtBalance = await variableDebtUSDC.balanceOf(subjectSetToken);

        const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
        const aWBTCPositionUnits = (await setToken.getPositions())[0].unit;
        const aWBTCFlows = preciseMulCeil(mintQuantity, aWBTCPositionUnits).sub(actualSeizedTokens);

        await subject();

        const debtPositionUnits = (await setToken.getPositions())[1].unit;
        const usdcFlows = preciseMul(mintQuantity, debtPositionUnits).mul(-1);

        const postMinterAWBTCBalance = await aWBTC.balanceOf(subjectCaller.address);
        const postSetAWBTCBalance = await aWBTC.balanceOf(subjectSetToken);
        const postMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const postSetUsdcDebtBalance = await variableDebtUSDC.balanceOf(subjectSetToken);

        expect(postMinterAWBTCBalance).to.eq(preMinterAWBTCBalance.sub(aWBTCFlows));
        expect(postSetAWBTCBalance).to.eq(preSetAWBTCBalance.add(aWBTCFlows));
        expect(postMinterUsdcBalance).to.eq(preMinterUsdcBalance.add(usdcFlows));
        expect(postSetUsdcDebtBalance).to.eq(preSetUsdcDebtBalance.add(usdcFlows));
      });
    });

    context("when 2 default positions and 2 external borrow positions", async () => {
      context("when default and external positions do not overlap", async () => {
        cacheBeforeEach(async () => {
          setToken = await setup.createSetToken(
            [aWBTC.address, setup.weth.address],
            [
              bitcoin(1),
              ether(1),
            ],
            [aaveLeverageModule.address, debtIssuanceModule.address]
          );
          issueFee = ether(0.005);
          await debtIssuanceModule.initialize(
            setToken.address,
            ether(0.02),
            issueFee,
            ether(0.005),
            feeRecipient.address,
            ADDRESS_ZERO
          );
          // Add SetToken to allow list
          await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
          await aaveLeverageModule.initialize(
            setToken.address,
            [setup.wbtc.address],
            [setup.dai.address, setup.usdc.address]
          );

          // Approve tokens to issuance module and call issue
          await aWBTC.approve(debtIssuanceModule.address, MAX_UINT_256);
          await setup.weth.approve(debtIssuanceModule.address, MAX_UINT_256);

          // Issue 1 SetToken
          issueQuantity = ether(1);
          await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

          // Lever up
          await aaveLeverageModule.lever(
            setToken.address,
            setup.dai.address,
            setup.wbtc.address,
            ether(100),
            bitcoin(0.01),
            "UniswapV2ExchangeAdapter",
            EMPTY_BYTES
          );

          await aaveLeverageModule.lever(
            setToken.address,
            setup.usdc.address,
            setup.wbtc.address,
            usdc(100),
            bitcoin(0.01),
            "UniswapV2ExchangeAdapter",
            EMPTY_BYTES
          );
        });

        beforeEach(() => {
          subjectSetToken = setToken.address;
          subjectQuantity = issueQuantity;
          subjectTo = owner.address;
          subjectCaller = owner;
        });

        it("should update the collateral position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];
          const newSecondPosition = (await setToken.getPositions())[1];

          expect(initialPositions.length).to.eq(4);
          expect(currentPositions.length).to.eq(4);

          expect(newFirstPosition.component).to.eq(aWBTC.address);
          expect(newFirstPosition.positionState).to.eq(0); // Default
          expect(newFirstPosition.unit).to.eq(initialPositions[0].unit);
          expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);

          expect(newSecondPosition.component).to.eq(setup.weth.address);
          expect(newSecondPosition.positionState).to.eq(0); // Default
          expect(newSecondPosition.unit).to.eq(initialPositions[1].unit); // Should be unchanged
          expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
        });

        it("should update the borrow position on the SetToken correctly", async () => {

          const setTotalSupply = await setToken.totalSupply();
          const previousThirdPositionBalance = await variableDebtDAI.balanceOf(setToken.address);
          const expectedThirdPositionUnit = preciseDiv(previousThirdPositionBalance, setTotalSupply).mul(-1);

          const previousFourthPositionBalance = await variableDebtUSDC.balanceOf(setToken.address);
          const expectedFourthPositionUnit = preciseDiv(previousFourthPositionBalance, setTotalSupply).mul(-1);

          await subject();

          const newThirdPosition = (await setToken.getPositions())[2];
          const newFourthPosition = (await setToken.getPositions())[3];

          expect(newThirdPosition.component).to.eq(setup.dai.address);
          expect(newThirdPosition.positionState).to.eq(1); // External
          expect(newThirdPosition.module).to.eq(aaveLeverageModule.address);
          // DAI has 18 decimal places. Use `expectGreaterThanOrEqualToWithUpperBound()` to account for the very small amount of interest accrued.
          await expectGreaterThanOrEqualToWithUpperBound(newThirdPosition.unit, expectedThirdPositionUnit);

          expect(newFourthPosition.component).to.eq(setup.usdc.address);
          expect(newFourthPosition.positionState).to.eq(1); // External
          expect(newFourthPosition.module).to.eq(aaveLeverageModule.address);
          expect(newFourthPosition.unit).to.eq(expectedFourthPositionUnit);   // Debt accrues but by an insignificant amount
        });

        it("should have the correct token balances", async () => {
          const preMinterAWBTCBalance = await aWBTC.balanceOf(subjectCaller.address);
          const preSetAWBTCBalance = await aWBTC.balanceOf(subjectSetToken);
          const preMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
          const preSetUsdcDebtBalance = await variableDebtUSDC.balanceOf(subjectSetToken);
          const preMinterDaiBalance = await setup.dai.balanceOf(subjectCaller.address);
          const preSetDaiDebtBalance = await variableDebtDAI.balanceOf(subjectSetToken);
          const preMinterWethBalance = await setup.weth.balanceOf(subjectCaller.address);
          const preSetWethBalance = await setup.weth.balanceOf(subjectSetToken);

          const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
          const newAWBTCPositionUnits = (await setToken.getPositions())[0].unit;
          const wethPositionUnits = (await setToken.getPositions())[1].unit;
          const aWBTCFlows = preciseMulCeil(mintQuantity, newAWBTCPositionUnits);
          const wethFlows = preciseMul(mintQuantity, wethPositionUnits);

          await subject();

          const daiDebtPositionUnits = (await setToken.getPositions())[2].unit;
          const usdcDebtPositionUnits = (await setToken.getPositions())[3].unit;
          const daiFlows = preciseMul(mintQuantity, daiDebtPositionUnits).mul(-1);
          const usdcFlows = preciseMul(mintQuantity, usdcDebtPositionUnits).mul(-1);

          const postMinterAWBTCBalance = await aWBTC.balanceOf(subjectCaller.address);
          const postSetAWBTCBalance = await aWBTC.balanceOf(subjectSetToken);
          const postMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
          const postSetUsdcDebtBalance = await variableDebtUSDC.balanceOf(subjectSetToken);
          const postMinterDaiBalance = await setup.dai.balanceOf(subjectCaller.address);
          const postSetDaiDebtBalance = await variableDebtDAI.balanceOf(subjectSetToken);
          const postMinterWethBalance = await setup.weth.balanceOf(subjectCaller.address);
          const postSetWethBalance = await setup.weth.balanceOf(subjectSetToken);

          expect(postMinterAWBTCBalance).to.eq(preMinterAWBTCBalance.sub(aWBTCFlows));
          expect(postSetAWBTCBalance).to.eq(preSetAWBTCBalance.add(aWBTCFlows));
          expect(postMinterUsdcBalance).to.eq(preMinterUsdcBalance.add(usdcFlows));
          expect(postMinterDaiBalance).to.eq(preMinterDaiBalance.add(daiFlows));
          expect(postMinterWethBalance).to.eq(preMinterWethBalance.sub(wethFlows));
          expect(postSetWethBalance).to.eq(preSetWethBalance.add(wethFlows));
          // USDC has 6 decimal places. Interest accrued doesn't reflect in balance immediately.
          expect(postSetUsdcDebtBalance).to.eq(preSetUsdcDebtBalance.add(usdcFlows));
          // DAI has 18 decimal places. Use `expectGreaterThanOrEqualToWithUpperBound()` to account for the very small amount of interest accrued.
          await expectGreaterThanOrEqualToWithUpperBound(postSetDaiDebtBalance, preSetDaiDebtBalance.add(daiFlows));
        });
      });

      context("when default and external positions do overlap", async () => {
        cacheBeforeEach(async () => {
          setToken = await setup.createSetToken(
            [aWBTC.address, setup.usdc.address],  // USDC is both a default and external position
            [
              bitcoin(1),
              usdc(100),
            ],
            [aaveLeverageModule.address, debtIssuanceModule.address]
          );
          issueFee = ether(0.005);
          await debtIssuanceModule.initialize(
            setToken.address,
            ether(0.02),
            issueFee,
            ether(0.005),
            feeRecipient.address,
            ADDRESS_ZERO
          );

          // Add SetToken to allow list
          await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
          await aaveLeverageModule.initialize(
            setToken.address,
            [setup.wbtc.address],
            [setup.usdc.address, setup.dai.address]   // USDC is both a default and external position
          );

          // Approve tokens to issuance module and call issue
          await aWBTC.approve(debtIssuanceModule.address, MAX_UINT_256);
          await setup.usdc.approve(debtIssuanceModule.address, MAX_UINT_256);

          // Issue 1 SetToken
          issueQuantity = ether(1);
          await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

          // Lever up
          await aaveLeverageModule.lever(
            setToken.address,
            setup.usdc.address,
            setup.wbtc.address,
            usdc(100),
            bitcoin(0.01),
            "UniswapV2ExchangeAdapter",
            EMPTY_BYTES
          );

          await aaveLeverageModule.lever(
            setToken.address,
            setup.dai.address,
            setup.wbtc.address,
            ether(100),
            bitcoin(0.01),
            "UniswapV2ExchangeAdapter",
            EMPTY_BYTES
          );
        });

        beforeEach(() => {
          subjectSetToken = setToken.address;
          subjectQuantity = issueQuantity;
          subjectTo = owner.address;
          subjectCaller = owner;
        });

        it("should update the collateral position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];
          const newSecondPosition = (await setToken.getPositions())[1];

          expect(initialPositions.length).to.eq(4);
          expect(currentPositions.length).to.eq(4);

          expect(newFirstPosition.component).to.eq(aWBTC.address);
          expect(newFirstPosition.positionState).to.eq(0); // Default
          expect(newFirstPosition.unit).to.eq(initialPositions[0].unit);
          expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);

          expect(newSecondPosition.component).to.eq(setup.usdc.address);
          expect(newSecondPosition.positionState).to.eq(0); // Default
          expect(newSecondPosition.unit).to.eq(initialPositions[1].unit); // Should be unchanged
          expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
        });

        it("should update the borrow position on the SetToken correctly", async () => {

          await subject();

          const setTotalSupply = await setToken.totalSupply();
          const previousThirdPositionBalance = await variableDebtUSDC.balanceOf(setToken.address);
          const expectedThirdPositionUnit = preciseDiv(previousThirdPositionBalance, setTotalSupply).mul(-1);

          const previousFourthPositionBalance = await variableDebtDAI.balanceOf(setToken.address);
          const expectedFourthPositionUnit = preciseDiv(previousFourthPositionBalance, setTotalSupply).mul(-1);

          const newThirdPosition = (await setToken.getPositions())[2];
          const newFourthPosition = (await setToken.getPositions())[3];

          expect(newThirdPosition.component).to.eq(setup.usdc.address);
          expect(newThirdPosition.positionState).to.eq(1); // External
          expect(newThirdPosition.unit).to.eq(expectedThirdPositionUnit);   // Debt accrues but doesn't reflect immediately
          expect(newThirdPosition.module).to.eq(aaveLeverageModule.address);

          expect(newFourthPosition.component).to.eq(setup.dai.address);
          expect(newFourthPosition.positionState).to.eq(1); // External
          expect(newFourthPosition.module).to.eq(aaveLeverageModule.address);
          // DAI has 18 decimal places. Use `expectGreaterThanOrEqualToWithUpperBound()` to account for the very small amount of interest accrued.
          await expectGreaterThanOrEqualToWithUpperBound(newFourthPosition.unit, expectedFourthPositionUnit);
        });

        it("should have the correct token balances", async () => {
          const preMinterAWBTCBalance = await aWBTC.balanceOf(subjectCaller.address);
          const preSetAWBTCBalance = await aWBTC.balanceOf(subjectSetToken);
          const preMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
          const preSetUsdcDebtBalance = await variableDebtUSDC.balanceOf(subjectSetToken);
          const preMinterDaiBalance = await setup.dai.balanceOf(subjectCaller.address);
          const preSetDaiDebtBalance = await variableDebtDAI.balanceOf(subjectSetToken);
          const preSetUsdcEquityBalance = await setup.usdc.balanceOf(subjectSetToken);

          const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
          const newAWBTCPositionUnits = (await setToken.getPositions())[0].unit;
          const usdcPositionUnits = (await setToken.getPositions())[1].unit;
          const aWBTCFlows = preciseMulCeil(mintQuantity, newAWBTCPositionUnits);
          const usdcEquityFlows = preciseMul(mintQuantity, usdcPositionUnits);

          await subject();

          const usdcDebtPositionUnits = (await setToken.getPositions())[2].unit;
          const daiDebtPositionUnits = (await setToken.getPositions())[3].unit;
          const usdcDebtFlows = preciseMul(mintQuantity, usdcDebtPositionUnits).mul(-1);
          const daiFlows = preciseMul(mintQuantity, daiDebtPositionUnits).mul(-1);

          const postMinterAWBTCBalance = await aWBTC.balanceOf(subjectCaller.address);
          const postSetAWBTCBalance = await aWBTC.balanceOf(subjectSetToken);
          const postMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
          const postSetUsdcDebtBalance = await variableDebtUSDC.balanceOf(subjectSetToken);
          const postMinterDaiBalance = await setup.dai.balanceOf(subjectCaller.address);
          const postSetDaiDebtBalance = await variableDebtDAI.balanceOf(subjectSetToken);
          const postSetUsdcEquityBalance = await setup.usdc.balanceOf(subjectSetToken);

          expect(postMinterAWBTCBalance).to.eq(preMinterAWBTCBalance.sub(aWBTCFlows));
          expect(postSetAWBTCBalance).to.eq(preSetAWBTCBalance.add(aWBTCFlows));
          expect(postSetUsdcEquityBalance).to.eq(preSetUsdcEquityBalance.add(usdcEquityFlows));
          expect(postMinterDaiBalance).to.eq(preMinterDaiBalance.add(daiFlows));
          expect(postMinterUsdcBalance).to.eq(preMinterUsdcBalance.sub(usdcEquityFlows).add(usdcDebtFlows));
          expect(postSetUsdcDebtBalance).to.eq(preSetUsdcDebtBalance.add(usdcDebtFlows));   // Debt accrues but doesn't reflect immediately
          // DAI has 18 decimal places. Use `expectGreaterThanOrEqualToWithUpperBound()` to account for the very small amount of interest accrued.
          await expectGreaterThanOrEqualToWithUpperBound(postSetDaiDebtBalance, preSetDaiDebtBalance.add(daiFlows));
        });
      });
    });
  });

  describe("#redemption", async () => {
    let setToken: SetToken;
    let redeemFee: BigNumber;
    let aWBTCUnits: BigNumber;
    let actualSeizedTokens: BigNumber;

    let subjectSetToken: Address;
    let subjectQuantity: BigNumber;
    let subjectTo: Address;
    let subjectCaller: Account;
    let issueQuantity: BigNumber;

    async function subject(): Promise<ContractTransaction> {
      return debtIssuanceModule.connect(subjectCaller.wallet).redeem(
        subjectSetToken,
        subjectQuantity,
        subjectTo,
      );
    }

    context("when a default aToken position and redeem will take supply to 0", async () => {
      cacheBeforeEach(async () => {
        aWBTCUnits = bitcoin(1);
        setToken = await setup.createSetToken(
          [aWBTC.address],
          [aWBTCUnits],
          [aaveLeverageModule.address, debtIssuanceModule.address]
        );
        await debtIssuanceModule.initialize(
          setToken.address,
          ether(0.02),
          ZERO,
          ZERO,
          feeRecipient.address,
          ADDRESS_ZERO
        );
        // Add SetToken to allow list
        await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
        await aaveLeverageModule.initialize(
          setToken.address,
          [setup.wbtc.address],
          [setup.usdc.address]
        );

        // Approve tokens to issuance module and call issue
        await aWBTC.approve(debtIssuanceModule.address, bitcoin(1000));

        // Issue 1 SetToken
        issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);
      });

      beforeEach(() => {
        subjectSetToken = setToken.address;
        subjectQuantity = issueQuantity;
        subjectTo = owner.address;
        subjectCaller = owner;
      });

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();
        await subject();

        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];
        expect(initialPositions.length).to.eq(1);
        expect(currentPositions.length).to.eq(1);
        expect(newFirstPosition.component).to.eq(aWBTC.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(aWBTCUnits);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        const currentPositions = await setToken.getPositions();

        expect(initialPositions.length).to.eq(1);
        expect(currentPositions.length).to.eq(1);
      });

      it("should have the correct token balances", async () => {
        const preMinterAWBTCBalance = await aWBTC.balanceOf(subjectCaller.address);
        const preSetAWBTCBalance = await aWBTC.balanceOf(subjectSetToken);
        const preMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const preSetUsdcBalance = await setup.usdc.balanceOf(subjectSetToken);

        await subject();

        const mintQuantity = preciseMul(subjectQuantity, ether(1));
        const usdcFlows = preciseMulCeil(mintQuantity, ZERO);
        const aWBTCFlows = preciseMul(mintQuantity, aWBTCUnits);

        const postMinterAWBTCBalance = await aWBTC.balanceOf(subjectCaller.address);
        const postSetAWBTCBalance = await aWBTC.balanceOf(subjectSetToken);
        const postMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const postSetUsdcBalance = await setup.usdc.balanceOf(subjectSetToken);

        expect(postMinterAWBTCBalance).to.eq(preMinterAWBTCBalance.add(aWBTCFlows));
        expect(postSetAWBTCBalance).to.eq(preSetAWBTCBalance.sub(aWBTCFlows));
        expect(postMinterUsdcBalance).to.eq(preMinterUsdcBalance.sub(usdcFlows)); // No debt
        expect(postSetUsdcBalance).to.eq(preSetUsdcBalance); // No debt
      });
    });

    context("when a default aToken position and external borrow position", async () => {
      let issueQuantity: BigNumber;

      cacheBeforeEach(async () => {

        aWBTCUnits = bitcoin(1);
        setToken = await setup.createSetToken(
          [aWBTC.address],
          [aWBTCUnits],
          [aaveLeverageModule.address, debtIssuanceModule.address]
        );
        redeemFee = ether(0.005);
        await debtIssuanceModule.initialize(
          setToken.address,
          ether(0.02),
          ether(0.005),
          redeemFee,
          feeRecipient.address,
          ADDRESS_ZERO
        );
        // Add SetToken to allow list
        await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
        await aaveLeverageModule.initialize(
          setToken.address,
          [setup.wbtc.address],
          [setup.usdc.address]
        );

        // Approve tokens to issuance module and call issue
        await aWBTC.approve(debtIssuanceModule.address, bitcoin(1000));

        // Issue 1 SetToken
        issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Lever up
        await aaveLeverageModule.lever(
          setToken.address,
          setup.usdc.address,
          setup.wbtc.address,
          usdc(500),
          bitcoin(0.4),
          "UniswapV2ExchangeAdapter",
          EMPTY_BYTES
        );

        // Approve debt token to issuance module for redeem
        await setup.usdc.approve(debtIssuanceModule.address, MAX_UINT_256);
      });

      beforeEach(() => {
        subjectSetToken = setToken.address;
        subjectQuantity = issueQuantity; // Redeem 1 SetToken so fee supply is left
        subjectTo = owner.address;
        subjectCaller = owner;
      });

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(aWBTC.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(initialPositions[0].unit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();
        const previousSecondPositionBalance = await variableDebtUSDC.balanceOf(setToken.address);
        const setTotalSupply = await setToken.totalSupply();

        await subject();

        const expectedSecondPositionUnit = preciseDivCeil(previousSecondPositionBalance, setTotalSupply).mul(-1);
        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component).to.eq(setup.usdc.address);
        expect(newSecondPosition.positionState).to.eq(1); // External
        expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
        expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
      });

      it("should have the correct token balances", async () => {
        const preRedeemerAWBTCBalance = await aWBTC.balanceOf(subjectCaller.address);
        const preSetAWBTCBalance = await aWBTC.balanceOf(subjectSetToken);
        const preRedeemerUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const preSetUsdcDebtBalance = await variableDebtUSDC.balanceOf(subjectSetToken);

        const redeemQuantity = preciseMul(subjectQuantity, ether(1).sub(redeemFee));

        await subject();

        const newAWBTCPositionUnits = (await setToken.getPositions())[0].unit;
        const aWBTCFlows = preciseMul(redeemQuantity, newAWBTCPositionUnits);
        const debtPositionUnits = (await setToken.getPositions())[1].unit;
        const usdcFlows = preciseMulCeil(redeemQuantity, debtPositionUnits.mul(-1));

        const postRedeemerAWBTCBalance = await aWBTC.balanceOf(subjectCaller.address);
        const postSetAWBTCBalance = await aWBTC.balanceOf(subjectSetToken);
        const postRedeemerUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const postSetUsdcDebtBalance = await variableDebtUSDC.balanceOf(subjectSetToken);

        expect(postRedeemerAWBTCBalance).to.eq(preRedeemerAWBTCBalance.add(aWBTCFlows));
        expect(postSetAWBTCBalance).to.eq(preSetAWBTCBalance.sub(aWBTCFlows));
        expect(postRedeemerUsdcBalance).to.eq(preRedeemerUsdcBalance.sub(usdcFlows));
        expect(postSetUsdcDebtBalance).to.eq(preSetUsdcDebtBalance.sub(usdcFlows));
      });
    });

    context("when a default aToken position and external borrow position with redeem to supply to 0", async () => {
      let issueQuantity: BigNumber;

      cacheBeforeEach(async () => {

        aWBTCUnits = bitcoin(1);
        setToken = await setup.createSetToken(
          [aWBTC.address],
          [aWBTCUnits],
          [aaveLeverageModule.address, debtIssuanceModule.address]
        );
        await debtIssuanceModule.initialize(
          setToken.address,
          ether(0.02),
          ZERO,
          ZERO,
          feeRecipient.address,
          ADDRESS_ZERO
        );
        // Add SetToken to allow list
        await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
        await aaveLeverageModule.initialize(
          setToken.address,
          [setup.wbtc.address],
          [setup.usdc.address]
        );

        // Approve tokens to issuance module and call issue
        await aWBTC.approve(debtIssuanceModule.address, bitcoin(1000));

        // Issue 1 SetToken
        issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Lever up
        await aaveLeverageModule.lever(
          setToken.address,
          setup.usdc.address,
          setup.wbtc.address,
          usdc(500),
          bitcoin(0.4),
          "UniswapV2ExchangeAdapter",
          EMPTY_BYTES
        );

        // Approve debt token to issuance module for redeem
        await setup.usdc.approve(debtIssuanceModule.address, MAX_UINT_256);
      });

      beforeEach(() => {
        subjectSetToken = setToken.address;
        subjectQuantity = issueQuantity; // Redeem 1 SetToken so fee supply is left
        subjectTo = owner.address;
        subjectCaller = owner;
      });

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(aWBTC.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(initialPositions[0].unit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();
        await subject();

        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];

        const setTotalSupply = await setToken.totalSupply();
        const currentSecondPositionBalance = await variableDebtUSDC.balanceOf(setToken.address);
        const usdcSetBalance = await setup.usdc.balanceOf(setToken.address);
        const adjustedSecondPositionBalance = currentSecondPositionBalance.mul(-1).add(usdcSetBalance);
        const newSecondPositionNotional = preciseMul(newSecondPosition.unit, setTotalSupply);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component).to.eq(setup.usdc.address);
        expect(newSecondPosition.positionState).to.eq(1); // External
        expect(newSecondPositionNotional).to.eq(adjustedSecondPositionBalance);
        expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
      });

      it("should have the correct token balances", async () => {
        const preRedeemerAWBTCBalance = await aWBTC.balanceOf(subjectCaller.address);
        const preSetAWBTCBalance = await aWBTC.balanceOf(subjectSetToken);
        const preRedeemerUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const preSetUsdcDebtBalance = await variableDebtUSDC.balanceOf(subjectSetToken);

        const redeemQuantity = preciseMul(subjectQuantity, ether(1));

        await subject();

        const newAWBTCPositionUnits = (await setToken.getPositions())[0].unit;
        const aWBTCFlows = preciseMul(redeemQuantity, newAWBTCPositionUnits);
        const debtPositionUnits = (await setToken.getPositions())[1].unit;
        const usdcFlows = preciseMulCeil(redeemQuantity, debtPositionUnits.mul(-1));

        const postRedeemerAWBTCBalance = await aWBTC.balanceOf(subjectCaller.address);
        const postSetAWBTCBalance = await aWBTC.balanceOf(subjectSetToken);
        const postRedeemerUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const postSetUsdcDebtBalance = await variableDebtUSDC.balanceOf(subjectSetToken);

        expect(postRedeemerAWBTCBalance).to.eq(preRedeemerAWBTCBalance.add(aWBTCFlows));
        expect(postSetAWBTCBalance).to.eq(preSetAWBTCBalance.sub(aWBTCFlows));
        expect(postRedeemerUsdcBalance).to.eq(preRedeemerUsdcBalance.sub(usdcFlows));
        expect(postSetUsdcDebtBalance).to.eq(preSetUsdcDebtBalance.sub(usdcFlows));
      });
    });

    context("when a default aToken position and liquidated borrow position", async () => {
      let issueQuantity: BigNumber;

      cacheBeforeEach(async () => {

        aWBTCUnits = bitcoin(1);
        setToken = await setup.createSetToken(
          [aWBTC.address],
          [aWBTCUnits],
          [aaveLeverageModule.address, debtIssuanceModule.address]
        );
        redeemFee = ether(0.005);
        await debtIssuanceModule.initialize(
          setToken.address,
          ether(0.02),
          ether(0.005),
          redeemFee,
          feeRecipient.address,
          ADDRESS_ZERO
        );
        // Add SetToken to allow list
        await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
        await aaveLeverageModule.initialize(
          setToken.address,
          [setup.wbtc.address],
          [setup.usdc.address]
        );

        // Approve tokens to issuance module and call issue
        await aWBTC.approve(debtIssuanceModule.address, bitcoin(1000));

        // Issue 1 SetToken
        issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Lever up
        await aaveLeverageModule.lever(
          setToken.address,
          setup.usdc.address,
          setup.wbtc.address,
          usdc(750),
          bitcoin(0.5),
          "UniswapV2ExchangeAdapter",
          EMPTY_BYTES
        );

        // ETH decreases to $400. 1 WBTC = 1 ETH = 400$.
        const liquidationUsdcPriceInEth = ether(0.0025);    // 1/400 = 0.0025
        await aaveV2Setup.setAssetPriceInOracle(setup.usdc.address, liquidationUsdcPriceInEth);

        // Liquidate 200 USDC
        const debtToCoverHumanReadable = 200;
        actualSeizedTokens = preciseMul(
          preciseMul(liquidationUsdcPriceInEth, ether(debtToCoverHumanReadable)),
          bitcoin(1.05)  // 5% liquidation bonus as configured in fixture
        );
        const debtToCover = usdc(debtToCoverHumanReadable);
        await setup.usdc.approve(aaveV2Setup.lendingPool.address, ether(250));

        await aaveV2Setup.lendingPool.connect(owner.wallet).liquidationCall(
          setup.wbtc.address,
          setup.usdc.address,
          setToken.address,
          debtToCover,
          true
        );

        // WBTC increases to $1000 to allow more borrow
        await aaveV2Setup.setAssetPriceInOracle(setup.usdc.address, ether(0.001));  // 1/1000 = .001

        // Approve debt token to issuance module for redeem
        await setup.usdc.approve(debtIssuanceModule.address, MAX_UINT_256);
      });

      beforeEach(() => {
        subjectSetToken = setToken.address;
        subjectQuantity = issueQuantity;
        subjectTo = owner.address;
        subjectCaller = owner;
      });

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();
        const setTotalSupply = await setToken.totalSupply();
        await subject();
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        const expectedPostLiquidationUnit = initialPositions[0].unit.sub(preciseDivCeil(actualSeizedTokens, setTotalSupply));
        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(aWBTC.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(expectedPostLiquidationUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();
        // aWBTC position is increased
        const setTotalSupply = await setToken.totalSupply();
        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];
        const previousSecondPositionBalance = await variableDebtUSDC.balanceOf(setToken.address);

        const newSecondPositionNotional = preciseMulCeil(newSecondPosition.unit.mul(-1), setTotalSupply);
        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component).to.eq(setup.usdc.address);
        expect(newSecondPosition.positionState).to.eq(1); // External
        expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
        // DAI has 18 decimal places. Use `expectGreaterThanOrEqualToWithUpperBound()` to account for the very small amount of interest accrued.
        await expectGreaterThanOrEqualToWithUpperBound(newSecondPositionNotional, previousSecondPositionBalance);
      });

      it("should have the correct token balances", async () => {
        const preRedeemerAWBTCBalance = await aWBTC.balanceOf(subjectCaller.address);
        const preSetAWBTCBalance = await aWBTC.balanceOf(subjectSetToken);
        const preRedeemerUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const preSetUsdcDebtBalance = await variableDebtUSDC.balanceOf(subjectSetToken);

        await subject();

        const redeemQuantity = preciseMul(subjectQuantity, ether(1).sub(redeemFee));
        const newAWBTCPositionUnits = (await setToken.getPositions())[0].unit;
        const aWBTCFlows = preciseMul(redeemQuantity, newAWBTCPositionUnits);

        const debtPositionUnits = (await setToken.getPositions())[1].unit;
        const usdcFlows = preciseMulCeil(redeemQuantity, debtPositionUnits.mul(-1));

        const postRedeemerAWBTCBalance = await aWBTC.balanceOf(subjectCaller.address);
        const postSetAWBTCBalance = await aWBTC.balanceOf(subjectSetToken);
        const postRedeemerUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const postSetUsdcDebtBalance = await variableDebtUSDC.balanceOf(subjectSetToken);

        expect(postRedeemerAWBTCBalance).to.eq(preRedeemerAWBTCBalance.add(aWBTCFlows));
        expect(postSetAWBTCBalance).to.eq(preSetAWBTCBalance.sub(aWBTCFlows));
        expect(postRedeemerUsdcBalance).to.eq(preRedeemerUsdcBalance.sub(usdcFlows));
        expect(postSetUsdcDebtBalance).to.eq(preSetUsdcDebtBalance.sub(usdcFlows));
      });
    });

    context("when 2 default positions and 2 external borrow positions", async () => {
      context("when default and external positions do not overlap", async () => {
        let issueQuantity: BigNumber;

        cacheBeforeEach(async () => {

          aWBTCUnits = bitcoin(1);
          setToken = await setup.createSetToken(
            [aWBTC.address, setup.weth.address],
            [aWBTCUnits, ether(1)],
            [aaveLeverageModule.address, debtIssuanceModule.address]
          );
          redeemFee = ether(0.005);
          await debtIssuanceModule.initialize(
            setToken.address,
            ether(0.02),
            ether(0.005),
            redeemFee,
            feeRecipient.address,
            ADDRESS_ZERO
          );
          // Add SetToken to allow list
          await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
          await aaveLeverageModule.initialize(
            setToken.address,
            [setup.wbtc.address],
            [setup.usdc.address, setup.dai.address]
          );

          // Approve tokens to issuance module and call issue
          await aWBTC.approve(debtIssuanceModule.address, bitcoin(1000));
          await setup.weth.approve(debtIssuanceModule.address, ether(1000));

          // Issue 1 SetToken
          issueQuantity = ether(1);
          await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

          // Lever up
          await aaveLeverageModule.lever(
            setToken.address,
            setup.usdc.address,
            setup.wbtc.address,
            usdc(500),
            bitcoin(0.4),
            "UniswapV2ExchangeAdapter",
            EMPTY_BYTES
          );

          await aaveLeverageModule.lever(
            setToken.address,
            setup.dai.address,
            setup.wbtc.address,
            ether(100),
            bitcoin(0.01),
            "UniswapV2ExchangeAdapter",
            EMPTY_BYTES
          );

          // Approve debt token to issuance module for redeem
          await setup.usdc.approve(debtIssuanceModule.address, MAX_UINT_256);
          await setup.dai.approve(debtIssuanceModule.address, MAX_UINT_256);
        });

        beforeEach(() => {
          subjectSetToken = setToken.address;
          subjectQuantity = issueQuantity; // Redeem 1 SetToken so fee supply is left
          subjectTo = owner.address;
          subjectCaller = owner;
        });

        it("should update the collateral position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];
          const newSecondPosition = (await setToken.getPositions())[1];

          expect(initialPositions.length).to.eq(4);
          expect(currentPositions.length).to.eq(4);

          expect(newFirstPosition.component).to.eq(aWBTC.address);
          expect(newFirstPosition.positionState).to.eq(0); // Default
          expect(newFirstPosition.unit).to.eq(initialPositions[0].unit);
          expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);

          expect(newSecondPosition.component).to.eq(setup.weth.address);
          expect(newSecondPosition.positionState).to.eq(0); // Default
          expect(newSecondPosition.unit).to.eq(initialPositions[1].unit); // Should be unchanged
          expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
        });

        it("should update the borrow position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();
          const setTotalSupply = await setToken.totalSupply();
          const previousThirdPositionBalance = await variableDebtUSDC.balanceOf(setToken.address);
          const previousFourthPositionBalance = await variableDebtDAI.balanceOf(setToken.address);

          await subject();

          const expectedThirdPositionUnit = preciseDivCeil(previousThirdPositionBalance, setTotalSupply).mul(-1);
          const expectedFourthPositionUnit = preciseDivCeil(previousFourthPositionBalance, setTotalSupply).mul(-1);

          const currentPositions = await setToken.getPositions();
          const newThirdPosition = (await setToken.getPositions())[2];
          const newFourthPosition = (await setToken.getPositions())[3];

          expect(initialPositions.length).to.eq(4);
          expect(currentPositions.length).to.eq(4);

          expect(newThirdPosition.component).to.eq(setup.usdc.address);
          expect(newThirdPosition.positionState).to.eq(1); // External
          expect(newThirdPosition.module).to.eq(aaveLeverageModule.address);
          expect(newThirdPosition.unit.abs()).to.eq(expectedThirdPositionUnit.abs());   // Debt accrues but doesn't reflect immediately

          expect(newFourthPosition.component).to.eq(setup.dai.address);
          expect(newFourthPosition.positionState).to.eq(1); // External
          expect(newFourthPosition.module).to.eq(aaveLeverageModule.address);
          // DAI has 18 decimal places. Use `expectGreaterThanOrEqualToWithUpperBound()` to account for the very small amount of interest accrued.
          await expectGreaterThanOrEqualToWithUpperBound(newFourthPosition.unit, expectedFourthPositionUnit);
        });

        it("should have the correct token balances", async () => {
          const preRedeemerAWBTCBalance = await aWBTC.balanceOf(subjectCaller.address);
          const preSetAWBTCBalance = await aWBTC.balanceOf(subjectSetToken);
          const preRedeemerUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
          const preSetUsdcDebtBalance = await variableDebtUSDC.balanceOf(subjectSetToken);
          const preRedeemerDaiBalance = await setup.dai.balanceOf(subjectCaller.address);
          const preSetDaiDebtBalance = await variableDebtDAI.balanceOf(subjectSetToken);
          const preRedeemerWethBalance = await setup.weth.balanceOf(subjectCaller.address);
          const preSetWethBalance = await setup.weth.balanceOf(subjectSetToken);

          const redeemQuantity = preciseMul(subjectQuantity, ether(1).sub(redeemFee));

          await subject();

          const newAWBTCPositionUnits = (await setToken.getPositions())[0].unit;
          const wethPositionUnits = (await setToken.getPositions())[1].unit;
          const usdcDebtPositionUnits = (await setToken.getPositions())[2].unit;
          const daiDebtPositionUnits = (await setToken.getPositions())[3].unit;
          const aWBTCFlows = preciseMul(redeemQuantity, newAWBTCPositionUnits);
          const wethFlows = preciseMul(redeemQuantity, wethPositionUnits);
          const usdcFlows = preciseMulCeil(redeemQuantity, usdcDebtPositionUnits.mul(-1));
          const daiFlows = preciseMulCeil(redeemQuantity, daiDebtPositionUnits.mul(-1));

          const postRedeemerAWBTCBalance = await aWBTC.balanceOf(subjectCaller.address);
          const postSetAWBTCBalance = await aWBTC.balanceOf(subjectSetToken);
          const postRedeemerUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
          const postSetUsdcDebtBalance = await variableDebtUSDC.balanceOf(subjectSetToken);
          const postRedeemerWethBalance = await setup.weth.balanceOf(subjectCaller.address);
          const postSetWethBalance = await setup.weth.balanceOf(subjectSetToken);
          const postRedeemerDaiBalance = await setup.dai.balanceOf(subjectCaller.address);
          const postSetDaiDebtBalance = await variableDebtDAI.balanceOf(subjectSetToken);

          expect(postRedeemerAWBTCBalance).to.eq(preRedeemerAWBTCBalance.add(aWBTCFlows));
          expect(postSetAWBTCBalance).to.eq(preSetAWBTCBalance.sub(aWBTCFlows));
          expect(postRedeemerUsdcBalance).to.eq(preRedeemerUsdcBalance.sub(usdcFlows));
          expect(postRedeemerWethBalance).to.eq(preRedeemerWethBalance.add(wethFlows));
          expect(postSetWethBalance).to.eq(preSetWethBalance.sub(wethFlows));
          expect(postRedeemerDaiBalance).to.eq(preRedeemerDaiBalance.sub(daiFlows));
          expect(postSetUsdcDebtBalance).to.eq(preSetUsdcDebtBalance.sub(usdcFlows));   // Debt accrues but doesn't reflect immediately
          // DAI has 18 decimal places. Use `expectGreaterThanOrEqualToWithUpperBound()` to account for the very small amount of interest accrued.
          await expectGreaterThanOrEqualToWithUpperBound(postSetDaiDebtBalance, preSetDaiDebtBalance.sub(daiFlows));
        });
      });

      context("when default and external positions do overlap", async () => {
        let issueQuantity: BigNumber;

        cacheBeforeEach(async () => {

          aWBTCUnits = bitcoin(1);
          setToken = await setup.createSetToken(
            [aWBTC.address, setup.usdc.address],    // USDC is both default and external position
            [aWBTCUnits, usdc(100)],
            [aaveLeverageModule.address, debtIssuanceModule.address]
          );
          redeemFee = ether(0.005);
          await debtIssuanceModule.initialize(
            setToken.address,
            ether(0.02),
            ether(0.005),
            redeemFee,
            feeRecipient.address,
            ADDRESS_ZERO
          );
          // Add SetToken to allow list
          await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
          await aaveLeverageModule.initialize(
            setToken.address,
            [setup.wbtc.address],
            [setup.usdc.address, setup.dai.address]
          );

          // Approve tokens to issuance module and call issue
          await aWBTC.approve(debtIssuanceModule.address, bitcoin(1000));
          await setup.usdc.approve(debtIssuanceModule.address, usdc(1000));

          // Issue 1 SetToken
          issueQuantity = ether(1);
          await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

          // Lever up
          await aaveLeverageModule.lever(
            setToken.address,
            setup.usdc.address,
            setup.wbtc.address,
            usdc(500),
            bitcoin(0.4),
            "UniswapV2ExchangeAdapter",
            EMPTY_BYTES
          );

          await aaveLeverageModule.lever(
            setToken.address,
            setup.dai.address,
            setup.wbtc.address,
            ether(100),
            bitcoin(0.01),
            "UniswapV2ExchangeAdapter",
            EMPTY_BYTES
          );

          // Approve debt token to issuance module for redeem
          await setup.usdc.approve(debtIssuanceModule.address, MAX_UINT_256);
          await setup.dai.approve(debtIssuanceModule.address, MAX_UINT_256);
        });

        beforeEach(() => {
          subjectSetToken = setToken.address;
          subjectQuantity = issueQuantity; // Redeem 1 SetToken so fee supply is left
          subjectTo = owner.address;
          subjectCaller = owner;
        });

        it("should update the collateral position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];
          const newSecondPosition = (await setToken.getPositions())[1];

          expect(initialPositions.length).to.eq(4);
          expect(currentPositions.length).to.eq(4);

          expect(newFirstPosition.component).to.eq(aWBTC.address);
          expect(newFirstPosition.positionState).to.eq(0); // Default
          expect(newFirstPosition.unit).to.eq(initialPositions[0].unit);
          expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);

          expect(newSecondPosition.component).to.eq(setup.usdc.address);
          expect(newSecondPosition.positionState).to.eq(0); // Default
          expect(newSecondPosition.unit).to.eq(initialPositions[1].unit); // Should be unchanged
          expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
        });

        it("should update the borrow position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();
          const setTotalSupply = await setToken.totalSupply();
          const previousThirdPositionBalance = await variableDebtUSDC.balanceOf(setToken.address);
          const previousFourthPositionBalance = await variableDebtDAI.balanceOf(setToken.address);

          await subject();

          const expectedThirdPositionUnit = preciseDivCeil(previousThirdPositionBalance, setTotalSupply).mul(-1);
          const expectedFourthPositionUnit = preciseDivCeil(previousFourthPositionBalance, setTotalSupply).mul(-1);

          const currentPositions = await setToken.getPositions();
          const newThirdPosition = (await setToken.getPositions())[2];
          const newFourthPosition = (await setToken.getPositions())[3];

          expect(initialPositions.length).to.eq(4);
          expect(currentPositions.length).to.eq(4);

          expect(newThirdPosition.component).to.eq(setup.usdc.address);
          expect(newThirdPosition.positionState).to.eq(1); // External
          expect(newThirdPosition.unit.abs()).to.eq(expectedThirdPositionUnit.abs());    // Debt accrues but doesn't reflect immediately
          expect(newThirdPosition.module).to.eq(aaveLeverageModule.address);

          expect(newFourthPosition.component).to.eq(setup.dai.address);
          expect(newFourthPosition.positionState).to.eq(1); // External
          expect(newFourthPosition.module).to.eq(aaveLeverageModule.address);
          // DAI has 18 decimal places. Use `expectGreaterThanOrEqualToWithUpperBound()` to account for the very small amount of interest accrued.
          await expectGreaterThanOrEqualToWithUpperBound(newFourthPosition.unit, expectedFourthPositionUnit);
        });

        it("should have the correct token balances", async () => {
          const preRedeemerAWBTCBalance = await aWBTC.balanceOf(subjectCaller.address);
          const preSetAWBTCBalance = await aWBTC.balanceOf(subjectSetToken);
          const preRedeemerUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
          const preSetUsdcDebtBalance = await variableDebtUSDC.balanceOf(subjectSetToken);
          const preSetUsdcEquityBalance = await setup.usdc.balanceOf(subjectSetToken);
          const preRedeemerDaiBalance = await setup.dai.balanceOf(subjectCaller.address);
          const preSetDaiDebtBalance = await variableDebtDAI.balanceOf(subjectSetToken);

          const redeemQuantity = preciseMul(subjectQuantity, ether(1).sub(redeemFee));

          await subject();

          const newAWBTCPositionUnits = (await setToken.getPositions())[0].unit;
          const usdcEquityPositionUnits = (await setToken.getPositions())[1].unit;
          const usdcDebtPositionUnits = (await setToken.getPositions())[2].unit;
          const daiDebtPositionUnits = (await setToken.getPositions())[3].unit;
          const aWBTCFlows = preciseMul(redeemQuantity, newAWBTCPositionUnits);
          const usdcEquityFlows = preciseMul(redeemQuantity, usdcEquityPositionUnits);
          const usdcDebtFlows = preciseMulCeil(redeemQuantity, usdcDebtPositionUnits.mul(-1));
          const daiDebtFlows = preciseMulCeil(redeemQuantity, daiDebtPositionUnits.mul(-1));

          const postRedeemerAWBTCBalance = await aWBTC.balanceOf(subjectCaller.address);
          const postSetAWBTCBalance = await aWBTC.balanceOf(subjectSetToken);
          const postRedeemerUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
          const postSetUsdcDebtBalance = await variableDebtUSDC.balanceOf(subjectSetToken);
          const postSetUsdcEquityBalance = await setup.usdc.balanceOf(subjectSetToken);
          const postRedeemerDaiBalance = await setup.dai.balanceOf(subjectCaller.address);
          const postSetDaiDebtBalance = await variableDebtDAI.balanceOf(subjectSetToken);

          expect(postRedeemerAWBTCBalance).to.eq(preRedeemerAWBTCBalance.add(aWBTCFlows));
          expect(postSetAWBTCBalance).to.eq(preSetAWBTCBalance.sub(aWBTCFlows));
          expect(postRedeemerUsdcBalance).to.eq(preRedeemerUsdcBalance.sub(usdcDebtFlows).add(usdcEquityFlows));
          expect(postSetUsdcDebtBalance).to.eq(preSetUsdcDebtBalance.sub(usdcDebtFlows));   // Debt accrues but doesn't reflect immediately
          expect(postSetUsdcEquityBalance).to.eq(preSetUsdcEquityBalance.sub(usdcEquityFlows));
          expect(postRedeemerDaiBalance).to.eq(preRedeemerDaiBalance.sub(daiDebtFlows));
          // DAI has 18 decimal places. Use `expectGreaterThanOrEqualToWithUpperBound()` to account for the very small amount of interest accrued.
          await expectGreaterThanOrEqualToWithUpperBound(postSetDaiDebtBalance, preSetDaiDebtBalance.sub(daiDebtFlows));
        });
      });
    });
  });
});
