import "module-alias/register";
import { ContractTransaction } from "ethers";
import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  AaveV2,
  AaveLeverageModule,
  DebtIssuanceModule,
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
import { BigNumber } from "@ethersproject/bignumber";
import { ADDRESS_ZERO, ZERO, EMPTY_BYTES, MAX_UINT_256 } from "@utils/constants";

const expect = getWaffleExpect();

// TODO: The following tests have been skipped due to inconsistent test results as they often revert with "Invalid post transfer balance"
// in ExplicitERC20#transferFrom function. It might be because aToken interest accrual depends upon block.timestamp and time difference
// between subsequent invocations of the Aave protocol. It is being further investigated and will be fixed in a different PR.
describe.skip("AaveUniswapLeverageDebtIssuance", () => {
  let owner: Account;
  let feeRecipient: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;
  let aaveV2Setup: AaveV2Fixture;
  let uniswapSetup: UniswapFixture;

  let aaveV2Library: AaveV2;
  let aaveLeverageModule: AaveLeverageModule;
  let debtIssuanceModule: DebtIssuanceModule;
  let uniswapExchangeAdapter: UniswapV2ExchangeAdapter;

  let aWETH: AaveV2AToken;
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
    await aaveV2Setup.setAssetPriceInOracle(setup.usdc.address, ether(0.001)); // Set to $1000 ETH

    // Mint aTokens on Aave
    await setup.weth.approve(aaveV2Setup.lendingPool.address, ether(1000));
    await aaveV2Setup.lendingPool.deposit(
      setup.weth.address,
      ether(1000),
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

    aWETH = aaveV2Setup.wethReserveTokens.aToken;

    variableDebtUSDC = usdcReserveTokens.variableDebtToken;
    variableDebtDAI = aaveV2Setup.daiReserveTokens.variableDebtToken;

    // Create ETH USDC pool and pool liquidity
    await uniswapSetup.createNewPair(setup.weth.address, setup.usdc.address);
    await setup.usdc.connect(owner.wallet).approve(uniswapSetup.router.address, MAX_UINT_256);
    await setup.weth.connect(owner.wallet).approve(uniswapSetup.router.address, MAX_UINT_256);
    await setup.dai.connect(owner.wallet).approve(uniswapSetup.router.address, MAX_UINT_256);

    // 100 ETH = 100k USDC. 1 ETH = 1000 USDC
    await uniswapSetup.router.connect(owner.wallet).addLiquidity(
      setup.weth.address,
      setup.usdc.address,
      ether(100),
      usdc(100000),
      ether(100),
      usdc(100000),
      owner.address,
      MAX_UINT_256
    );

    // 100 ETH = 100k DAI. 1 ETH = 1000 DAI
    await uniswapSetup.router.connect(owner.wallet).addLiquidity(
      setup.weth.address,
      setup.dai.address,
      ether(100),
      ether(100000),
      ether(100),
      ether(100000),
      owner.address,
      MAX_UINT_256
    );

    debtIssuanceModule = await deployer.modules.deployDebtIssuanceModule(setup.controller.address);
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
    let aWETHUnits: BigNumber;
    let actualSeizedTokens: BigNumber;

    let subjectSetToken: Address;
    let subjectQuantity: BigNumber;
    let subjectTo: Address;
    let subjectCaller: Account;
    let issueQuantity: BigNumber;

    context("when a default aToken position with 0 supply", async () => {
      cacheBeforeEach(async () => {
        // Borrow some WETH to ensure the aWETH balance increases due to interest
        await aaveV2Setup.lendingPool.borrow(setup.weth.address, ether(10), 2, ZERO, owner.address);

        aWETHUnits = ether(1);
        setToken = await setup.createSetToken(
          [aWETH.address],
          [aWETHUnits],
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
          [setup.weth.address],
          [setup.usdc.address]
        );

        // Approve tokens to issuance module and call issue
        await aWETH.approve(debtIssuanceModule.address, ether(1000));

        // Issue 1 SetToken
        issueQuantity = ether(1);
      });

      beforeEach(() => {
        subjectSetToken = setToken.address;
        subjectQuantity = issueQuantity;
        subjectTo = owner.address;
        subjectCaller = owner;
      });

      async function subject(): Promise<ContractTransaction> {
        return debtIssuanceModule.connect(subjectCaller.wallet).issue(
          subjectSetToken,
          subjectQuantity,
          subjectTo,
        );
      }

      it("should not update the collateral position on the SetToken", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        expect(initialPositions.length).to.eq(1);
        expect(currentPositions.length).to.eq(1);
        expect(newFirstPosition.component).to.eq(aWETH.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(aWETHUnits);
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
        const preMinterAWETHBalance = await aWETH.balanceOf(subjectCaller.address);
        const preSetAWETHBalance = await aWETH.balanceOf(subjectSetToken);
        const preMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const preSetUsdcBalance = await setup.usdc.balanceOf(subjectSetToken);

        await subject();

        const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
        const usdcFlows = preciseMulCeil(mintQuantity, ZERO);
        const aWETHFlows = preciseMul(mintQuantity, aWETHUnits);

        const postMinterAWETHBalance = await aWETH.balanceOf(subjectCaller.address);
        const postSetAWETHBalance = await aWETH.balanceOf(subjectSetToken);
        const postMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const postSetUsdcBalance = await setup.usdc.balanceOf(subjectSetToken);

        // Note: Due to 1 aToken = 1 underlying and interest accruing every block, it is difficult to track precise
        // balances without replicating interest rate logic. Therefore, we expect actual balances to be greater
        // than expected due to interest accruals on aWETH
        expect(postMinterAWETHBalance).to.gte(preMinterAWETHBalance.sub(aWETHFlows));
        expect(postSetAWETHBalance).to.gte(preSetAWETHBalance.add(aWETHFlows));
        expect(postMinterUsdcBalance).to.eq(preMinterUsdcBalance.add(usdcFlows)); // No debt
        expect(postSetUsdcBalance).to.eq(preSetUsdcBalance); // No debt
      });
    });

    context("when a default aToken position and external borrow position", async () => {
      let issueQuantity: BigNumber;

      cacheBeforeEach(async () => {
        // Borrow some WETH to ensure the aWETH balance increases due to interest
        await aaveV2Setup.lendingPool.borrow(setup.weth.address, ether(10), 2, ZERO, owner.address);

        aWETHUnits = ether(1);
        setToken = await setup.createSetToken(
          [aWETH.address],
          [aWETHUnits],
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
          [setup.weth.address],
          [setup.usdc.address]
        );

        // Approve tokens to issuance module and call issue
        await aWETH.approve(debtIssuanceModule.address, ether(1000));

        // Issue 1 SetToken
        issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Lever up
        await aaveLeverageModule.lever(
          setToken.address,
          setup.usdc.address,
          setup.weth.address,
          usdc(500),
          ether(0.4),
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

      async function subject(): Promise<ContractTransaction> {
        return debtIssuanceModule.connect(subjectCaller.wallet).issue(
          subjectSetToken,
          subjectQuantity,
          subjectTo,
        );
      }

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // aWETH position is increased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(aWETH.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.gte(initialPositions[0].unit); // Should be greater due to interest accrual
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
        const preMinteraWETHBalance = await aWETH.balanceOf(subjectCaller.address);
        const preSetAWETHBalance = await aWETH.balanceOf(subjectSetToken);
        const preMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const preSetUsdcDebtBalance = await variableDebtUSDC.balanceOf(subjectSetToken);

        const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
        const newAWETHPositionUnits = (await setToken.getPositions())[0].unit;
        const aWETHFlows = preciseMulCeil(mintQuantity, newAWETHPositionUnits);

        await subject();

        const debtPositionUnits = (await setToken.getPositions())[1].unit;
        const usdcFlows = preciseMul(mintQuantity, debtPositionUnits).mul(-1);

        const postMinteraWETHBalance = await aWETH.balanceOf(subjectCaller.address);
        const postSetAWETHBalance = await aWETH.balanceOf(subjectSetToken);
        const postMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const postSetUsdcDebtBalance = await variableDebtUSDC.balanceOf(subjectSetToken);

        expect(postMinteraWETHBalance).to.gte(preMinteraWETHBalance.sub(aWETHFlows));
        expect(postSetAWETHBalance).to.gte(preSetAWETHBalance.add(aWETHFlows));
        expect(postMinterUsdcBalance).to.eq(preMinterUsdcBalance.add(usdcFlows));
        expect(postSetUsdcDebtBalance).to.eq(preSetUsdcDebtBalance.add(usdcFlows));
      });
    });

    context("when a default aToken position and liquidated borrow position", async () => {
      let issueQuantity: BigNumber;

      cacheBeforeEach(async () => {
        // TODO: Borrow some WETH to ensure the aWETH balance increases due to interest
        // await aaveV2Setup.lendingPool.borrow(setup.weth.address, ether(10), 2, ZERO, owner.address);

        aWETHUnits = ether(1);
        setToken = await setup.createSetToken(
          [aWETH.address],
          [aWETHUnits],
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
          [setup.weth.address],
          [setup.usdc.address]
        );

        // Approve tokens to issuance module and call issue
        await aWETH.approve(debtIssuanceModule.address, ether(1000));

        // Issue 1 SetToken
        issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Lever up
        await aaveLeverageModule.lever(
          setToken.address,
          setup.usdc.address,
          setup.weth.address,
          usdc(750),
          ether(0.5),
          "UniswapV2ExchangeAdapter",
          EMPTY_BYTES
        );

        // ETH decreases to $400
        const liquidationUsdcPriceInEth = ether(0.0025);    // 1/400 = 0.0025
        await aaveV2Setup.setAssetPriceInOracle(setup.usdc.address, liquidationUsdcPriceInEth);

        // Liquidate 200 USDC
        const debtToCoverHumanReadable = 200;
        actualSeizedTokens = preciseMul(
          preciseMul(liquidationUsdcPriceInEth, ether(debtToCoverHumanReadable)),
          ether(1.05)  // 5% liquidation bonus as configured in fixture
        );
        const debtToCover = usdc(debtToCoverHumanReadable);
        await setup.usdc.approve(aaveV2Setup.lendingPool.address, ether(250));

        await aaveV2Setup.lendingPool.connect(owner.wallet).liquidationCall(
          setup.weth.address,
          setup.usdc.address,
          setToken.address,
          debtToCover,
          true
        );

        // ETH increases to $1000 to allow more borrow
        await aaveV2Setup.setAssetPriceInOracle(setup.usdc.address, ether(0.001));  // 1/1000 = .001

        // TODO: Test Increase time
        // await increaseTimeAsync(BigNumber.from(86400));
      });

      beforeEach(() => {
        subjectSetToken = setToken.address;
        subjectQuantity = issueQuantity;
        subjectTo = owner.address;
        subjectCaller = owner;
      });

      async function subject(): Promise<ContractTransaction> {
        return debtIssuanceModule.connect(subjectCaller.wallet).issue(
          subjectSetToken,
          subjectQuantity,
          subjectTo,
        );
      }

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();
        const setTotalSupply = await setToken.totalSupply();

        await subject();
        // aWETH position is increased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        const expectedPostLiquidationUnit = initialPositions[0].unit.sub(preciseDivCeil(actualSeizedTokens, setTotalSupply));
        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(aWETH.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(expectedPostLiquidationUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        const previousSecondPositionBalance = await variableDebtUSDC.balanceOf(setToken.address);
        const setTotalSupply = await setToken.totalSupply();

        await subject();

        // aWETH position is increased
        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];

        const expectedSecondPositionUnit = preciseDiv(previousSecondPositionBalance, setTotalSupply).mul(-1);
        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component).to.eq(setup.usdc.address);
        expect(newSecondPosition.positionState).to.eq(1); // External
        expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
        expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
      });

      it("should have the correct token balances", async () => {
        const preMinterAWETHBalance = await aWETH.balanceOf(subjectCaller.address);
        const preSetAWETHBalance = await aWETH.balanceOf(subjectSetToken);
        const preMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const preSetUsdcDebtBalance = await variableDebtUSDC.balanceOf(subjectSetToken);

        const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
        const newAWETHPositionUnits = (await setToken.getPositions())[0].unit;
        const aWETHFlows = preciseMulCeil(mintQuantity, newAWETHPositionUnits).sub(actualSeizedTokens);

        await subject();

        const debtPositionUnits = (await setToken.getPositions())[1].unit;
        const usdcFlows = preciseMul(mintQuantity, debtPositionUnits).mul(-1);

        const postMinterAWETHBalance = await aWETH.balanceOf(subjectCaller.address);
        const postSetAWETHBalance = await aWETH.balanceOf(subjectSetToken);
        const postMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const postSetUsdcDebtBalance = await variableDebtUSDC.balanceOf(subjectSetToken);

        expect(postMinterAWETHBalance).to.eq(preMinterAWETHBalance.sub(aWETHFlows));
        expect(postSetAWETHBalance).to.eq(preSetAWETHBalance.add(aWETHFlows));
        expect(postMinterUsdcBalance).to.eq(preMinterUsdcBalance.add(usdcFlows));
        expect(postSetUsdcDebtBalance).to.gte(preSetUsdcDebtBalance.add(usdcFlows));
      });
    });

    context("when 2 default positions and 2 external borrow positions", async () => {
      let issueQuantity: BigNumber;

      cacheBeforeEach(async () => {
        setToken = await setup.createSetToken(
          [aWETH.address, setup.wbtc.address],
          [
            ether(1),
            bitcoin(1),
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
          [setup.weth.address],
          [setup.dai.address, setup.usdc.address]
        );

        // Approve tokens to issuance module and call issue
        await aWETH.approve(debtIssuanceModule.address, MAX_UINT_256);
        await setup.wbtc.approve(debtIssuanceModule.address, MAX_UINT_256);

        // Issue 1 SetToken
        issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Lever up
        await aaveLeverageModule.lever(
          setToken.address,
          setup.dai.address,
          setup.weth.address,
          ether(100),
          ether(0.01),
          "UniswapV2ExchangeAdapter",
          EMPTY_BYTES
        );

        await aaveLeverageModule.lever(
          setToken.address,
          setup.usdc.address,
          setup.weth.address,
          usdc(100),
          ether(0.01),
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

      async function subject(): Promise<ContractTransaction> {
        return debtIssuanceModule.connect(subjectCaller.wallet).issue(
          subjectSetToken,
          subjectQuantity,
          subjectTo,
        );
      }

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // aWETH position is increased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];
        const newSecondPosition = (await setToken.getPositions())[1];

        expect(initialPositions.length).to.eq(4);
        expect(currentPositions.length).to.eq(4);

        expect(newFirstPosition.component).to.eq(aWETH.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(initialPositions[0].unit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);

        expect(newSecondPosition.component).to.eq(setup.wbtc.address);
        expect(newSecondPosition.positionState).to.eq(0); // Default
        expect(newSecondPosition.unit).to.eq(initialPositions[1].unit); // Should be unchanged
        expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {

        await subject();

        const setTotalSupply = await setToken.totalSupply();
        const previousThirdPositionBalance = await variableDebtDAI.balanceOf(setToken.address);
        const expectedThirdPositionUnit = preciseDiv(previousThirdPositionBalance, setTotalSupply).mul(-1);

        const previousFourthPositionBalance = await variableDebtUSDC.balanceOf(setToken.address);
        const expectedFourthPositionUnit = preciseDiv(previousFourthPositionBalance, setTotalSupply).mul(-1);

        const newThirdPosition = (await setToken.getPositions())[2];
        const newFourthPosition = (await setToken.getPositions())[3];

        expect(newThirdPosition.component).to.eq(setup.dai.address);
        expect(newThirdPosition.positionState).to.eq(1); // External
        expect(newThirdPosition.unit).to.eq(expectedThirdPositionUnit);
        expect(newThirdPosition.module).to.eq(aaveLeverageModule.address);

        expect(newFourthPosition.component).to.eq(setup.usdc.address);
        expect(newFourthPosition.positionState).to.eq(1); // External
        expect(newFourthPosition.unit).to.eq(expectedFourthPositionUnit);
        expect(newFourthPosition.module).to.eq(aaveLeverageModule.address);
      });

      it("should have the correct token balances", async () => {
        const preMinterAWETHBalance = await aWETH.balanceOf(subjectCaller.address);
        const preSetAWETHBalance = await aWETH.balanceOf(subjectSetToken);
        const preMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const preSetUsdcDebtBalance = await variableDebtUSDC.balanceOf(subjectSetToken);
        const preMinterDaiBalance = await setup.dai.balanceOf(subjectCaller.address);
        const preSetDaiDebtBalance = await variableDebtDAI.balanceOf(subjectSetToken);
        const preMinterWbtcBalance = await setup.wbtc.balanceOf(subjectCaller.address);
        const preSetWbtcBalance = await setup.wbtc.balanceOf(subjectSetToken);

        const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
        const setTotalSupply = await setToken.totalSupply();
        const newAWETHPositionUnits = (await setToken.getPositions())[0].unit;
        const aWETHFlows = preciseMulCeil(mintQuantity, newAWETHPositionUnits);

        await subject();

        const daiDebtPositionUnits = (await setToken.getPositions())[2].unit;
        const usdcDebtPositionUnits = (await setToken.getPositions())[3].unit;
        const daiFlows = preciseMul(mintQuantity, daiDebtPositionUnits).mul(-1);
        const usdcFlows = preciseMul(mintQuantity, usdcDebtPositionUnits).mul(-1);
        const wbtcFlows = preciseMul(bitcoin(1), setTotalSupply); // 1 BTC unit

        const postMinterAWETHBalance = await aWETH.balanceOf(subjectCaller.address);
        const postSetAWETHBalance = await aWETH.balanceOf(subjectSetToken);
        const postMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const postSetUsdcDebtBalance = await variableDebtUSDC.balanceOf(subjectSetToken);
        const postMinterDaiBalance = await setup.dai.balanceOf(subjectCaller.address);
        const postSetDaiDebtBalance = await variableDebtDAI.balanceOf(subjectSetToken);
        const postMinterWbtcBalance = await setup.wbtc.balanceOf(subjectCaller.address);
        const postSetWbtcBalance = await setup.wbtc.balanceOf(subjectSetToken);

        expect(postMinterAWETHBalance).to.eq(preMinterAWETHBalance.sub(aWETHFlows));
        expect(postSetAWETHBalance).to.eq(preSetAWETHBalance.add(aWETHFlows));
        expect(postMinterUsdcBalance).to.eq(preMinterUsdcBalance.add(usdcFlows));
        expect(postSetUsdcDebtBalance).to.gte(preSetUsdcDebtBalance.add(usdcFlows)); // Round up due to interest accrual
        expect(postMinterDaiBalance).to.eq(preMinterDaiBalance.add(daiFlows));
        expect(postSetDaiDebtBalance).to.gte(preSetDaiDebtBalance.add(daiFlows)); // Round up due to interest accrual
        expect(postMinterWbtcBalance).to.eq(preMinterWbtcBalance.sub(wbtcFlows));
        expect(postSetWbtcBalance).to.eq(preSetWbtcBalance.add(wbtcFlows));
      });
    });
  });

  describe("#redemption", async () => {
    let setToken: SetToken;
    let redeemFee: BigNumber;
    let aWETHUnits: BigNumber;
    let actualSeizedTokens: BigNumber;

    let subjectSetToken: Address;
    let subjectQuantity: BigNumber;
    let subjectTo: Address;
    let subjectCaller: Account;
    let issueQuantity: BigNumber;

    context("when a default aToken position and redeem will take supply to 0", async () => {
      cacheBeforeEach(async () => {
        aWETHUnits = ether(1);
        setToken = await setup.createSetToken(
          [aWETH.address],
          [aWETHUnits],
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
          [setup.weth.address],
          [setup.usdc.address]
        );

        // Approve tokens to issuance module and call issue
        await aWETH.approve(debtIssuanceModule.address, ether(1000));

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

      async function subject(): Promise<ContractTransaction> {
        return debtIssuanceModule.connect(subjectCaller.wallet).redeem(
          subjectSetToken,
          subjectQuantity,
          subjectTo,
        );
      }

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();
        await subject();

        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];
        expect(initialPositions.length).to.eq(1);
        expect(currentPositions.length).to.eq(1);
        expect(newFirstPosition.component).to.eq(aWETH.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(aWETHUnits);
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
        const preMinterAWETHBalance = await aWETH.balanceOf(subjectCaller.address);
        const preSetAWETHBalance = await aWETH.balanceOf(subjectSetToken);
        const preMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const preSetUsdcBalance = await setup.usdc.balanceOf(subjectSetToken);

        await subject();

        const mintQuantity = preciseMul(subjectQuantity, ether(1));
        const usdcFlows = preciseMulCeil(mintQuantity, ZERO);
        const aWETHFlows = preciseMul(mintQuantity, aWETHUnits);

        const postMinterAWETHBalance = await aWETH.balanceOf(subjectCaller.address);
        const postSetAWETHBalance = await aWETH.balanceOf(subjectSetToken);
        const postMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const postSetUsdcBalance = await setup.usdc.balanceOf(subjectSetToken);

        expect(postMinterAWETHBalance).to.eq(preMinterAWETHBalance.add(aWETHFlows));
        expect(postSetAWETHBalance).to.eq(preSetAWETHBalance.sub(aWETHFlows));
        expect(postMinterUsdcBalance).to.eq(preMinterUsdcBalance.sub(usdcFlows)); // No debt
        expect(postSetUsdcBalance).to.eq(preSetUsdcBalance); // No debt
      });
    });

    context("when a default aToken position and external borrow position", async () => {
      let issueQuantity: BigNumber;

      cacheBeforeEach(async () => {

        aWETHUnits = ether(1);
        setToken = await setup.createSetToken(
          [aWETH.address],
          [aWETHUnits],
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
          [setup.weth.address],
          [setup.usdc.address]
        );

        // Approve tokens to issuance module and call issue
        await aWETH.approve(debtIssuanceModule.address, ether(1000));

        // Issue 1 SetToken
        issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Lever up
        await aaveLeverageModule.lever(
          setToken.address,
          setup.usdc.address,
          setup.weth.address,
          usdc(500),
          ether(0.4),
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

      async function subject(): Promise<ContractTransaction> {
        return debtIssuanceModule.connect(subjectCaller.wallet).redeem(
          subjectSetToken,
          subjectQuantity,
          subjectTo,
        );
      }

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // aWETH position is increased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(aWETH.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(initialPositions[0].unit); // Should be greater due to interest accrual
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
        expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit); // Should be greater due to interest accrual
        expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
      });

      it("should have the correct token balances", async () => {
        const preRedeemerAWETHBalance = await aWETH.balanceOf(subjectCaller.address);
        const preSetAWETHBalance = await aWETH.balanceOf(subjectSetToken);
        const preRedeemerUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const preSetUsdcDebtBalance = await variableDebtUSDC.balanceOf(subjectSetToken);

        const redeemQuantity = preciseMul(subjectQuantity, ether(1).sub(redeemFee));

        await subject();

        const newAWETHPositionUnits = (await setToken.getPositions())[0].unit;
        const aWETHFlows = preciseMul(redeemQuantity, newAWETHPositionUnits);
        const debtPositionUnits = (await setToken.getPositions())[1].unit;
        const usdcFlows = preciseMulCeil(redeemQuantity, debtPositionUnits.mul(-1));

        const postRedeemerAWETHBalance = await aWETH.balanceOf(subjectCaller.address);
        const postSetAWETHBalance = await aWETH.balanceOf(subjectSetToken);
        const postRedeemerUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const postSetUsdcDebtBalance = await variableDebtUSDC.balanceOf(subjectSetToken);

        expect(postRedeemerAWETHBalance).to.eq(preRedeemerAWETHBalance.add(aWETHFlows));
        expect(postSetAWETHBalance).to.eq(preSetAWETHBalance.sub(aWETHFlows));
        expect(postRedeemerUsdcBalance).to.eq(preRedeemerUsdcBalance.sub(usdcFlows));
        expect(postSetUsdcDebtBalance).to.eq(preSetUsdcDebtBalance.sub(usdcFlows));
      });
    });

    context("when a default aToken position and external borrow position with redeem to supply to 0", async () => {
      let issueQuantity: BigNumber;

      cacheBeforeEach(async () => {

        aWETHUnits = ether(1);
        setToken = await setup.createSetToken(
          [aWETH.address],
          [aWETHUnits],
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
          [setup.weth.address],
          [setup.usdc.address]
        );

        // Approve tokens to issuance module and call issue
        await aWETH.approve(debtIssuanceModule.address, ether(1000));

        // Issue 1 SetToken
        issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Lever up
        await aaveLeverageModule.lever(
          setToken.address,
          setup.usdc.address,
          setup.weth.address,
          usdc(500),
          ether(0.4),
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

      async function subject(): Promise<ContractTransaction> {
        return debtIssuanceModule.connect(subjectCaller.wallet).redeem(
          subjectSetToken,
          subjectQuantity,
          subjectTo,
        );
      }

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // aWETH position is increased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(aWETH.address);
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
        const preRedeemerAWETHBalance = await aWETH.balanceOf(subjectCaller.address);
        const preSetAWETHBalance = await aWETH.balanceOf(subjectSetToken);
        const preRedeemerUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const preSetUsdcDebtBalance = await variableDebtUSDC.balanceOf(subjectSetToken);

        const redeemQuantity = preciseMul(subjectQuantity, ether(1));

        await subject();

        const newAWETHPositionUnits = (await setToken.getPositions())[0].unit;
        const aWETHFlows = preciseMul(redeemQuantity, newAWETHPositionUnits);
        const debtPositionUnits = (await setToken.getPositions())[1].unit;
        const usdcFlows = preciseMulCeil(redeemQuantity, debtPositionUnits.mul(-1));

        const postRedeemerAWETHBalance = await aWETH.balanceOf(subjectCaller.address);
        const postSetAWETHBalance = await aWETH.balanceOf(subjectSetToken);
        const postRedeemerUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const postSetUsdcDebtBalance = await variableDebtUSDC.balanceOf(subjectSetToken);

        expect(postRedeemerAWETHBalance).to.eq(preRedeemerAWETHBalance.add(aWETHFlows));
        expect(postSetAWETHBalance).to.eq(preSetAWETHBalance.sub(aWETHFlows));
        expect(postRedeemerUsdcBalance).to.eq(preRedeemerUsdcBalance.sub(usdcFlows));
        expect(postSetUsdcDebtBalance).to.eq(preSetUsdcDebtBalance.sub(usdcFlows));
      });
    });

    context("when a default aToken position and liquidated borrow position", async () => {
      let issueQuantity: BigNumber;

      cacheBeforeEach(async () => {

        aWETHUnits = ether(1);
        setToken = await setup.createSetToken(
          [aWETH.address],
          [aWETHUnits],
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
          [setup.weth.address],
          [setup.usdc.address]
        );

        // Approve tokens to issuance module and call issue
        await aWETH.approve(debtIssuanceModule.address, ether(1000));

        // Issue 1 SetToken
        issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Lever up
        await aaveLeverageModule.lever(
          setToken.address,
          setup.usdc.address,
          setup.weth.address,
          usdc(750),
          ether(0.5),
          "UniswapV2ExchangeAdapter",
          EMPTY_BYTES
        );

         // ETH decreases to $400
        const liquidationUsdcPriceInEth = ether(0.0025);    // 1/400 = 0.0025
        await aaveV2Setup.setAssetPriceInOracle(setup.usdc.address, liquidationUsdcPriceInEth);

        // Liquidate 200 USDC
        const debtToCoverHumanReadable = 200;
        actualSeizedTokens = preciseMul(
          preciseMul(liquidationUsdcPriceInEth, ether(debtToCoverHumanReadable)),
          ether(1.05)  // 5% liquidation bonus as configured in fixture
        );
        const debtToCover = usdc(debtToCoverHumanReadable);
        await setup.usdc.approve(aaveV2Setup.lendingPool.address, ether(250));

        await aaveV2Setup.lendingPool.connect(owner.wallet).liquidationCall(
          setup.weth.address,
          setup.usdc.address,
          setToken.address,
          debtToCover,
          true
        );

        // ETH increases to $1000 to allow more borrow
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

      async function subject(): Promise<ContractTransaction> {
        return debtIssuanceModule.connect(subjectCaller.wallet).redeem(
          subjectSetToken,
          subjectQuantity,
          subjectTo,
        );
      }

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();
        const setTotalSupply = await setToken.totalSupply();
        await subject();
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        const expectedPostLiquidationUnit = initialPositions[0].unit.sub(preciseDivCeil(actualSeizedTokens, setTotalSupply));
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
        // aWETH position is increased
        const setTotalSupply = await setToken.totalSupply();
        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];
        const previousSecondPositionBalance = await variableDebtUSDC.balanceOf(setToken.address);

        const newSecondPositionNotional = preciseMulCeil(newSecondPosition.unit.mul(-1), setTotalSupply);
        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component).to.eq(setup.usdc.address);
        expect(newSecondPosition.positionState).to.eq(1); // External
        expect(newSecondPositionNotional).to.eq(previousSecondPositionBalance);
        expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
      });

      it("should have the correct token balances", async () => {
        const preRedeemerAWETHBalance = await aWETH.balanceOf(subjectCaller.address);
        const preSetAWETHBalance = await aWETH.balanceOf(subjectSetToken);
        const preRedeemerUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const preSetUsdcDebtBalance = await variableDebtUSDC.balanceOf(subjectSetToken);

        await subject();

        const redeemQuantity = preciseMul(subjectQuantity, ether(1).sub(redeemFee));
        const newAWETHPositionUnits = (await setToken.getPositions())[0].unit;
        const aWETHFlows = preciseMul(redeemQuantity, newAWETHPositionUnits);

        const debtPositionUnits = (await setToken.getPositions())[1].unit;
        const usdcFlows = preciseMulCeil(redeemQuantity, debtPositionUnits.mul(-1));

        const postRedeemerAWETHBalance = await aWETH.balanceOf(subjectCaller.address);
        const postSetAWETHBalance = await aWETH.balanceOf(subjectSetToken);
        const postRedeemerUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const postSetUsdcDebtBalance = await variableDebtUSDC.balanceOf(subjectSetToken);

        expect(postRedeemerAWETHBalance).to.eq(preRedeemerAWETHBalance.add(aWETHFlows));
        expect(postSetAWETHBalance).to.gte(preSetAWETHBalance.sub(aWETHFlows));
        expect(postRedeemerUsdcBalance).to.eq(preRedeemerUsdcBalance.sub(usdcFlows));
        expect(postSetUsdcDebtBalance).to.eq(preSetUsdcDebtBalance.sub(usdcFlows));
      });
    });
  });
});
