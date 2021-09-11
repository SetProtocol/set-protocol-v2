import "module-alias/register";
import { ContractTransaction } from "ethers";
import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  Compound,
  CompoundLeverageModule,
  DebtIssuanceModule,
  SetToken,
  UniswapV2ExchangeAdapter,
} from "@utils/contracts";
import { CEther, CERc20 } from "@utils/contracts/compound";
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
  getCompoundFixture,
  getUniswapFixture,
} from "@utils/test/index";
import { CompoundFixture, SystemFixture, UniswapFixture } from "@utils/fixtures";
import { BigNumber } from "ethers";
import { ADDRESS_ZERO, ZERO, EMPTY_BYTES, MAX_UINT_256 } from "@utils/constants";

const expect = getWaffleExpect();

describe("CompoundUniswapLeverageDebtIssuance", () => {
  let owner: Account;
  let feeRecipient: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;
  let compoundSetup: CompoundFixture;
  let uniswapSetup: UniswapFixture;

  let compoundLibrary: Compound;
  let compoundLeverageModule: CompoundLeverageModule;
  let debtIssuanceModule: DebtIssuanceModule;
  let uniswapExchangeAdapter: UniswapV2ExchangeAdapter;
  let cEther: CEther;
  let cUsdc: CERc20;
  let cDai: CERc20;

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

    compoundSetup = getCompoundFixture(owner.address);
    await compoundSetup.initialize();

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

    cEther = await compoundSetup.createAndEnableCEther(
      ether(200000000),
      compoundSetup.comptroller.address,
      compoundSetup.interestRateModel.address,
      "Compound ether",
      "cETH",
      8,
      ether(0.75), // 75% collateral factor
      ether(1000)
    );

    cUsdc = await compoundSetup.createAndEnableCToken(
      setup.usdc.address,
      usdc(2000000000),
      compoundSetup.comptroller.address,
      compoundSetup.interestRateModel.address,
      "Compound USDC",
      "cUSDC",
      8,
      ether(0.75), // 75% collateral factor
      ether(1000000000000) // Compound oracles account for decimals. $1 * 10^18 * 10^18 / 10^6
    );

    cDai = await compoundSetup.createAndEnableCToken(
      setup.dai.address,
      ether(200000000),
      compoundSetup.comptroller.address,
      compoundSetup.interestRateModel.address,
      "Compound DAI",
      "cDAI",
      8,
      ether(0.75), // 75% collateral factor
      ether(1)
    );

    await compoundSetup.comptroller._setCompRate(ether(1));
    await compoundSetup.comptroller._addCompMarkets([cEther.address, cUsdc.address, cDai.address]);

    // Mint cTokens
    await setup.usdc.approve(cUsdc.address, ether(100000));
    await setup.dai.approve(cDai.address, ether(100000));
    await cUsdc.mint(usdc(1000000));
    await cEther.mint({value: ether(1000)});
    await cDai.mint(ether(1000));

    debtIssuanceModule = await deployer.modules.deployDebtIssuanceModule(setup.controller.address);
    await setup.controller.addModule(debtIssuanceModule.address);

    compoundLibrary = await deployer.libraries.deployCompound();
    compoundLeverageModule = await deployer.modules.deployCompoundLeverageModule(
      setup.controller.address,
      compoundSetup.comp.address,
      compoundSetup.comptroller.address,
      cEther.address,
      setup.weth.address,
      "contracts/protocol/integration/lib/Compound.sol:Compound",
      compoundLibrary.address,
    );
    await setup.controller.addModule(compoundLeverageModule.address);

    // Deploy Uniswap exchange adapter
    uniswapExchangeAdapter = await deployer.adapters.deployUniswapV2ExchangeAdapter(uniswapSetup.router.address);

    await setup.integrationRegistry.addIntegration(
      compoundLeverageModule.address,
      "UniswapV2ExchangeAdapter",
      uniswapExchangeAdapter.address
    );

    // Add debt issuance address to integration
    await setup.integrationRegistry.addIntegration(
      compoundLeverageModule.address,
      "DefaultIssuanceModule",
      debtIssuanceModule.address
    );
  });

  describe("#issuance", async () => {
    let setToken: SetToken;
    let issueFee: BigNumber;
    let cEtherUnits: BigNumber;
    let actualSeizedTokens: BigNumber[];

    let subjectSetToken: Address;
    let subjectQuantity: BigNumber;
    let subjectTo: Address;
    let subjectCaller: Account;
    let issueQuantity: BigNumber;

    context("when a default cToken position with 0 supply", async () => {
      cacheBeforeEach(async () => {
        cEtherUnits = BigNumber.from(10000000000);
        setToken = await setup.createSetToken(
          [cEther.address],
          [cEtherUnits],
          [compoundLeverageModule.address, debtIssuanceModule.address]
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
        await compoundLeverageModule.updateAllowedSetToken(setToken.address, true);
        await compoundLeverageModule.initialize(
          setToken.address,
          [setup.weth.address],
          [setup.usdc.address]
        );

        // Approve tokens to issuance module and call issue
        await cEther.approve(debtIssuanceModule.address, ether(1000));

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
        expect(newFirstPosition.component).to.eq(cEther.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(cEtherUnits);
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
        const preMinterCEtherBalance = await cEther.balanceOf(subjectCaller.address);
        const preSetCEtherBalance = await cEther.balanceOf(subjectSetToken);
        const preMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const preSetUsdcBalance = await setup.usdc.balanceOf(subjectSetToken);

        await subject();

        const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
        const usdcFlows = preciseMulCeil(mintQuantity, ZERO);
        const cEtherFlows = preciseMul(mintQuantity, cEtherUnits);

        const postMinterCEtherBalance = await cEther.balanceOf(subjectCaller.address);
        const postSetCEtherBalance = await cEther.balanceOf(subjectSetToken);
        const postMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const postSetUsdcBalance = await setup.usdc.balanceOf(subjectSetToken);

        expect(postMinterCEtherBalance).to.eq(preMinterCEtherBalance.sub(cEtherFlows));
        expect(postSetCEtherBalance).to.eq(preSetCEtherBalance.add(cEtherFlows));
        expect(postMinterUsdcBalance).to.eq(preMinterUsdcBalance.add(usdcFlows));
        expect(postSetUsdcBalance).to.eq(preSetUsdcBalance);
      });
    });

    context("when a default cToken position and external borrow position", async () => {
      let issueQuantity: BigNumber;

      cacheBeforeEach(async () => {
        cEtherUnits = BigNumber.from(10000000000);
        setToken = await setup.createSetToken(
          [cEther.address],
          [cEtherUnits],
          [compoundLeverageModule.address, debtIssuanceModule.address]
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
        await compoundLeverageModule.updateAllowedSetToken(setToken.address, true);
        await compoundLeverageModule.initialize(
          setToken.address,
          [setup.weth.address],
          [setup.usdc.address]
        );

        // Approve tokens to issuance module and call issue
        await cEther.approve(debtIssuanceModule.address, ether(1000));

        // Issue 1 SetToken
        issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Lever up
        await compoundLeverageModule.lever(
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

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(cEther.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(initialPositions[0].unit); // Should be unchanged
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();
        const previousSecondPositionBalance = await cUsdc.borrowBalanceStored(setToken.address);
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
        expect(newSecondPosition.module).to.eq(compoundLeverageModule.address);
      });

      it("should have the correct token balances", async () => {
        const preMinterCEtherBalance = await cEther.balanceOf(subjectCaller.address);
        const preSetCEtherBalance = await cEther.balanceOf(subjectSetToken);
        const preMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const preSetUsdcBalance = await setup.usdc.balanceOf(subjectSetToken);
        const preExternalUsdcBalance = await setup.usdc.balanceOf(cUsdc.address);

        const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
        const newCEtherPositionUnits = (await setToken.getPositions())[0].unit;
        const cEtherFlows = preciseMulCeil(mintQuantity, newCEtherPositionUnits);

        await subject();

        const debtPositionUnits = (await setToken.getPositions())[1].unit;
        const usdcFlows = preciseMul(mintQuantity, debtPositionUnits).mul(-1);

        const postMinterCEtherBalance = await cEther.balanceOf(subjectCaller.address);
        const postSetCEtherBalance = await cEther.balanceOf(subjectSetToken);
        const postMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const postSetUsdcBalance = await setup.usdc.balanceOf(subjectSetToken);
        const postExternalUsdcBalance = await setup.usdc.balanceOf(cUsdc.address);


        expect(postMinterCEtherBalance).to.eq(preMinterCEtherBalance.sub(cEtherFlows));
        expect(postSetCEtherBalance).to.eq(preSetCEtherBalance.add(cEtherFlows));
        expect(postMinterUsdcBalance).to.eq(preMinterUsdcBalance.add(usdcFlows));
        expect(postSetUsdcBalance).to.eq(preSetUsdcBalance);
        expect(postExternalUsdcBalance).to.eq(preExternalUsdcBalance.sub(usdcFlows));
      });
    });

    context("when a default cToken position and liquidated borrow position", async () => {
      let issueQuantity: BigNumber;

      cacheBeforeEach(async () => {
        cEtherUnits = BigNumber.from(5000000000);
        setToken = await setup.createSetToken(
          [cEther.address],
          [cEtherUnits],
          [compoundLeverageModule.address, debtIssuanceModule.address]
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
        await compoundLeverageModule.updateAllowedSetToken(setToken.address, true);
        await compoundLeverageModule.initialize(
          setToken.address,
          [setup.weth.address],
          [setup.usdc.address]
        );

        // Approve tokens to issuance module and call issue
        await cEther.approve(debtIssuanceModule.address, ether(1000));

        // Issue 1 SetToken
        issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Lever up
        await compoundLeverageModule.lever(
          setToken.address,
          setup.usdc.address,
          setup.weth.address,
          usdc(750),
          ether(0.5),
          "UniswapV2ExchangeAdapter",
          EMPTY_BYTES
        );

        // Set price to be liquidated
        const liquidationEthPrice = ether(500);
        await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, liquidationEthPrice);

        await setup.usdc.approve(cUsdc.address, MAX_UINT_256);
        const unitsToLiquidate = usdc(250);
        actualSeizedTokens = await compoundSetup.comptroller.liquidateCalculateSeizeTokens(
          cUsdc.address,
          cEther.address,
          unitsToLiquidate
        );

        await cUsdc.liquidateBorrow(setToken.address, unitsToLiquidate, cEther.address);

        await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(1000));
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
        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        const expectedPostLiquidationUnit = initialPositions[0].unit.sub(preciseDiv(actualSeizedTokens[1], setTotalSupply));
        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(cEther.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(expectedPostLiquidationUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await compoundLeverageModule.sync(setToken.address, true);
        const previousSecondPositionBalance = await cUsdc.borrowBalanceStored(setToken.address);
        const setTotalSupply = await setToken.totalSupply();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];

        const expectedSecondPositionUnit = preciseDivCeil(previousSecondPositionBalance, setTotalSupply).mul(-1);
        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component).to.eq(setup.usdc.address);
        expect(newSecondPosition.positionState).to.eq(1); // External
        expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
        expect(newSecondPosition.module).to.eq(compoundLeverageModule.address);
      });

      it("should have the correct token balances", async () => {
        const preMinterCEtherBalance = await cEther.balanceOf(subjectCaller.address);
        const preSetCEtherBalance = await cEther.balanceOf(subjectSetToken);
        const preMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const preSetUsdcBalance = await setup.usdc.balanceOf(subjectSetToken);
        const preExternalUsdcBalance = await setup.usdc.balanceOf(cUsdc.address);

        const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
        const newCEtherPositionUnits = (await setToken.getPositions())[0].unit;
        const cEtherFlows = preciseMulCeil(mintQuantity, newCEtherPositionUnits).sub(actualSeizedTokens[1]);

        await subject();

        const debtPositionUnits = (await setToken.getPositions())[1].unit;
        const usdcFlows = preciseMul(mintQuantity, debtPositionUnits).mul(-1);

        const postMinterCEtherBalance = await cEther.balanceOf(subjectCaller.address);
        const postSetCEtherBalance = await cEther.balanceOf(subjectSetToken);
        const postMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const postSetUsdcBalance = await setup.usdc.balanceOf(subjectSetToken);
        const postExternalUsdcBalance = await setup.usdc.balanceOf(cUsdc.address);

        expect(postMinterCEtherBalance).to.eq(preMinterCEtherBalance.sub(cEtherFlows));
        expect(postSetCEtherBalance).to.eq(preSetCEtherBalance.add(cEtherFlows));
        expect(postMinterUsdcBalance).to.eq(preMinterUsdcBalance.add(usdcFlows));
        expect(postSetUsdcBalance).to.eq(preSetUsdcBalance);
        expect(postExternalUsdcBalance).to.eq(preExternalUsdcBalance.sub(usdcFlows));
      });
    });

    context("when 2 default positions and 2 external borrow positions", async () => {
      let issueQuantity: BigNumber;

      cacheBeforeEach(async () => {
        setToken = await setup.createSetToken(
          [cEther.address, setup.wbtc.address],
          [
            BigNumber.from(5000000000),
            bitcoin(1),
          ],
          [compoundLeverageModule.address, debtIssuanceModule.address]
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
        await compoundLeverageModule.updateAllowedSetToken(setToken.address, true);
        await compoundLeverageModule.initialize(
          setToken.address,
          [setup.weth.address],
          [setup.dai.address, setup.usdc.address]
        );

        // Approve tokens to issuance module and call issue
        await cEther.approve(debtIssuanceModule.address, MAX_UINT_256);
        await setup.wbtc.approve(debtIssuanceModule.address, MAX_UINT_256);

        // Issue 1 SetToken
        issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Lever up
        await compoundLeverageModule.lever(
          setToken.address,
          setup.dai.address,
          setup.weth.address,
          ether(100),
          ether(0.01),
          "UniswapV2ExchangeAdapter",
          EMPTY_BYTES
        );

        await compoundLeverageModule.lever(
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

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];
        const newSecondPosition = (await setToken.getPositions())[1];

        expect(initialPositions.length).to.eq(4);
        expect(currentPositions.length).to.eq(4);

        expect(newFirstPosition.component).to.eq(cEther.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(initialPositions[0].unit); // Should be unchanged
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);

        expect(newSecondPosition.component).to.eq(setup.wbtc.address);
        expect(newSecondPosition.positionState).to.eq(0); // Default
        expect(newSecondPosition.unit).to.eq(initialPositions[1].unit); // Should be unchanged
        expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const setTotalSupply = await setToken.totalSupply();

        const previousThirdPositionBalance = await cDai.borrowBalanceStored(setToken.address);
        const expectedThirdPositionUnit = preciseDivCeil(previousThirdPositionBalance, setTotalSupply).mul(-1);

        const previousFourthPositionBalance = await cUsdc.borrowBalanceStored(setToken.address);
        const expectedFourthPositionUnit = preciseDivCeil(previousFourthPositionBalance, setTotalSupply).mul(-1);

        await subject();

        const newThirdPosition = (await setToken.getPositions())[2];
        const newFourthPosition = (await setToken.getPositions())[3];

        expect(newThirdPosition.component).to.eq(setup.dai.address);
        expect(newThirdPosition.positionState).to.eq(1); // External
        expect(newThirdPosition.unit).to.eq(expectedThirdPositionUnit);
        expect(newThirdPosition.module).to.eq(compoundLeverageModule.address);

        expect(newFourthPosition.component).to.eq(setup.usdc.address);
        expect(newFourthPosition.positionState).to.eq(1); // External
        expect(newFourthPosition.unit).to.eq(expectedFourthPositionUnit);
        expect(newFourthPosition.module).to.eq(compoundLeverageModule.address);
      });

      it("should have the correct token balances", async () => {
        const preMinterCEtherBalance = await cEther.balanceOf(subjectCaller.address);
        const preSetCEtherBalance = await cEther.balanceOf(subjectSetToken);
        const preMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const preSetUsdcBalance = await setup.usdc.balanceOf(subjectSetToken);
        const preMinterDaiBalance = await setup.dai.balanceOf(subjectCaller.address);
        const preSetDaiBalance = await setup.dai.balanceOf(subjectSetToken);
        const preMinterWbtcBalance = await setup.wbtc.balanceOf(subjectCaller.address);
        const preSetWbtcBalance = await setup.wbtc.balanceOf(subjectSetToken);
        const preExternalUsdcBalance = await setup.usdc.balanceOf(cUsdc.address);
        const preExternalDaiBalance = await setup.dai.balanceOf(cDai.address);

        const mintQuantity = preciseMul(subjectQuantity, ether(1).add(issueFee));
        const setTotalSupply = await setToken.totalSupply();
        const newCEtherPositionUnits = (await setToken.getPositions())[0].unit;
        const cEtherFlows = preciseMulCeil(mintQuantity, newCEtherPositionUnits);

        await subject();

        const daiDebtPositionUnits = (await setToken.getPositions())[2].unit;
        const usdcDebtPositionUnits = (await setToken.getPositions())[3].unit;
        const daiFlows = preciseMul(mintQuantity, daiDebtPositionUnits).mul(-1);
        const usdcFlows = preciseMul(mintQuantity, usdcDebtPositionUnits).mul(-1);
        const wbtcFlows = preciseMul(bitcoin(1), setTotalSupply); // 1 BTC unit

        const postMinterCEtherBalance = await cEther.balanceOf(subjectCaller.address);
        const postSetCEtherBalance = await cEther.balanceOf(subjectSetToken);
        const postMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const postSetUsdcBalance = await setup.usdc.balanceOf(subjectSetToken);
        const postMinterDaiBalance = await setup.dai.balanceOf(subjectCaller.address);
        const postSetDaiBalance = await setup.dai.balanceOf(subjectSetToken);
        const postMinterWbtcBalance = await setup.wbtc.balanceOf(subjectCaller.address);
        const postSetWbtcBalance = await setup.wbtc.balanceOf(subjectSetToken);
        const postExternalUsdcBalance = await setup.usdc.balanceOf(cUsdc.address);
        const postExternalDaiBalance = await setup.dai.balanceOf(cDai.address);

        expect(postMinterCEtherBalance).to.eq(preMinterCEtherBalance.sub(cEtherFlows));
        expect(postSetCEtherBalance).to.eq(preSetCEtherBalance.add(cEtherFlows));
        expect(postMinterUsdcBalance).to.eq(preMinterUsdcBalance.add(usdcFlows));
        expect(postSetUsdcBalance).to.eq(preSetUsdcBalance);
        expect(postMinterDaiBalance).to.eq(preMinterDaiBalance.add(daiFlows));
        expect(postSetDaiBalance).to.eq(preSetDaiBalance);
        expect(postMinterWbtcBalance).to.eq(preMinterWbtcBalance.sub(wbtcFlows));
        expect(postSetWbtcBalance).to.eq(preSetWbtcBalance.add(wbtcFlows));
        expect(postExternalUsdcBalance).to.eq(preExternalUsdcBalance.sub(usdcFlows));
        expect(postExternalDaiBalance).to.eq(preExternalDaiBalance.sub(daiFlows));
      });
    });
  });

  describe("#redemption", async () => {
    let setToken: SetToken;
    let redeemFee: BigNumber;
    let cEtherUnits: BigNumber;
    let actualSeizedTokens: BigNumber[];

    let subjectSetToken: Address;
    let subjectQuantity: BigNumber;
    let subjectTo: Address;
    let subjectCaller: Account;
    let issueQuantity: BigNumber;

    context("when a default cToken position and redeem will take supply to 0", async () => {
      cacheBeforeEach(async () => {
        cEtherUnits = BigNumber.from(10000000000);
        setToken = await setup.createSetToken(
          [cEther.address],
          [cEtherUnits],
          [compoundLeverageModule.address, debtIssuanceModule.address]
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
        await compoundLeverageModule.updateAllowedSetToken(setToken.address, true);
        await compoundLeverageModule.initialize(
          setToken.address,
          [setup.weth.address],
          [setup.usdc.address]
        );

        // Approve tokens to issuance module and call issue
        await cEther.approve(debtIssuanceModule.address, ether(1000));

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
        expect(newFirstPosition.component).to.eq(cEther.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(cEtherUnits);
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
        const preMinterCEtherBalance = await cEther.balanceOf(subjectCaller.address);
        const preSetCEtherBalance = await cEther.balanceOf(subjectSetToken);
        const preMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const preSetUsdcBalance = await setup.usdc.balanceOf(subjectSetToken);

        await subject();

        const mintQuantity = preciseMul(subjectQuantity, ether(1));
        const usdcFlows = preciseMulCeil(mintQuantity, ZERO);
        const cEtherFlows = preciseMul(mintQuantity, cEtherUnits);

        const postMinterCEtherBalance = await cEther.balanceOf(subjectCaller.address);
        const postSetCEtherBalance = await cEther.balanceOf(subjectSetToken);
        const postMinterUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const postSetUsdcBalance = await setup.usdc.balanceOf(subjectSetToken);

        expect(postMinterCEtherBalance).to.eq(preMinterCEtherBalance.add(cEtherFlows));
        expect(postSetCEtherBalance).to.eq(preSetCEtherBalance.sub(cEtherFlows));
        expect(postMinterUsdcBalance).to.eq(preMinterUsdcBalance.sub(usdcFlows));
        expect(postSetUsdcBalance).to.eq(preSetUsdcBalance);
      });
    });

    context("when a default cToken position and external borrow position", async () => {
      let issueQuantity: BigNumber;

      cacheBeforeEach(async () => {
        cEtherUnits = BigNumber.from(10000000000);
        setToken = await setup.createSetToken(
          [cEther.address],
          [cEtherUnits],
          [compoundLeverageModule.address, debtIssuanceModule.address]
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
        await compoundLeverageModule.updateAllowedSetToken(setToken.address, true);
        await compoundLeverageModule.initialize(
          setToken.address,
          [setup.weth.address],
          [setup.usdc.address]
        );

        // Approve tokens to issuance module and call issue
        await cEther.approve(debtIssuanceModule.address, ether(1000));

        // Issue 1 SetToken
        issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Lever up
        await compoundLeverageModule.lever(
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
        subjectQuantity = issueQuantity; // Redeem 1 SetToken so only fee supply is left
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

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(cEther.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(initialPositions[0].unit); // Should be unchanged
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();
        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];

        const setTotalSupply = await setToken.totalSupply();
        const previousSecondPositionBalance = (await cUsdc.borrowBalanceStored(setToken.address)).mul(-1);
        const newSecondPositionNotional = preciseMul(newSecondPosition.unit, setTotalSupply);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component).to.eq(setup.usdc.address);
        expect(newSecondPosition.positionState).to.eq(1); // External
        expect(newSecondPositionNotional).to.eq(previousSecondPositionBalance);
        expect(newSecondPosition.module).to.eq(compoundLeverageModule.address);
      });

      it("should have the correct token balances", async () => {
        const preRedeemerCEtherBalance = await cEther.balanceOf(subjectCaller.address);
        const preSetCEtherBalance = await cEther.balanceOf(subjectSetToken);
        const preRedeemerUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const preExternalUsdcBalance = await setup.usdc.balanceOf(cUsdc.address);

        const redeemQuantity = preciseMul(subjectQuantity, ether(1).sub(redeemFee));

        const newCEtherPositionUnits = (await setToken.getPositions())[0].unit;
        const cEtherFlows = preciseMul(redeemQuantity, newCEtherPositionUnits);

        await subject();

        const debtPositionUnits = (await setToken.getPositions())[1].unit;
        const usdcFlows = preciseMulCeil(redeemQuantity, debtPositionUnits.mul(-1));

        const postRedeemerCEtherBalance = await cEther.balanceOf(subjectCaller.address);
        const postSetCEtherBalance = await cEther.balanceOf(subjectSetToken);
        const postRedeemerUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const postSetUsdcBalance = await setup.usdc.balanceOf(subjectSetToken);
        const postExternalUsdcBalance = await setup.usdc.balanceOf(cUsdc.address);
        expect(postRedeemerCEtherBalance).to.eq(preRedeemerCEtherBalance.add(cEtherFlows));
        expect(postSetCEtherBalance).to.eq(preSetCEtherBalance.sub(cEtherFlows));
        expect(postRedeemerUsdcBalance).to.eq(preRedeemerUsdcBalance.sub(usdcFlows));
        expect(postSetUsdcBalance).to.eq(ZERO);
        expect(postExternalUsdcBalance).to.eq(preExternalUsdcBalance.add(usdcFlows));
      });
    });

    context("when a default cToken position and external borrow position with redeem to supply to 0", async () => {
      let issueQuantity: BigNumber;

      cacheBeforeEach(async () => {
        cEtherUnits = BigNumber.from(10000000000);
        setToken = await setup.createSetToken(
          [cEther.address],
          [cEtherUnits],
          [compoundLeverageModule.address, debtIssuanceModule.address]
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
        await compoundLeverageModule.updateAllowedSetToken(setToken.address, true);
        await compoundLeverageModule.initialize(
          setToken.address,
          [setup.weth.address],
          [setup.usdc.address]
        );

        // Approve tokens to issuance module and call issue
        await cEther.approve(debtIssuanceModule.address, ether(1000));

        // Issue 1 SetToken
        issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Lever up
        await compoundLeverageModule.lever(
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
        subjectQuantity = issueQuantity; // Redeem 1 SetToken so only fee supply is left
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

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(cEther.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(initialPositions[0].unit); // Should be unchanged
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();
        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];

        const setTotalSupply = await setToken.totalSupply();
        const currentSecondPositionBalance = await cUsdc.borrowBalanceStored(setToken.address);
        const usdcSetBalance = await setup.usdc.balanceOf(setToken.address);
        const adjustedSecondPositionBalance = currentSecondPositionBalance.mul(-1).add(usdcSetBalance);
        const newSecondPositionNotional = preciseMul(newSecondPosition.unit, setTotalSupply);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component).to.eq(setup.usdc.address);
        expect(newSecondPosition.positionState).to.eq(1); // External
        expect(newSecondPositionNotional).to.eq(adjustedSecondPositionBalance);
        expect(newSecondPosition.module).to.eq(compoundLeverageModule.address);
      });

      it("should have the correct token balances", async () => {
        const preRedeemerCEtherBalance = await cEther.balanceOf(subjectCaller.address);
        const preSetCEtherBalance = await cEther.balanceOf(subjectSetToken);
        const preRedeemerUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const preExternalUsdcBalance = await setup.usdc.balanceOf(cUsdc.address);

        const redeemQuantity = preciseMul(subjectQuantity, ether(1));
        const newCEtherPositionUnits = (await setToken.getPositions())[0].unit;
        const cEtherFlows = preciseMul(redeemQuantity, newCEtherPositionUnits);

        await subject();

        const debtPositionUnits = (await setToken.getPositions())[1].unit;
        const usdcFlows = preciseMulCeil(redeemQuantity, debtPositionUnits.mul(-1));

        const postRedeemerCEtherBalance = await cEther.balanceOf(subjectCaller.address);
        const postSetCEtherBalance = await cEther.balanceOf(subjectSetToken);
        const postRedeemerUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const postSetUsdcBalance = await setup.usdc.balanceOf(subjectSetToken);
        const postExternalUsdcBalance = await setup.usdc.balanceOf(cUsdc.address);
        expect(postRedeemerCEtherBalance).to.eq(preRedeemerCEtherBalance.add(cEtherFlows));
        expect(postSetCEtherBalance).to.eq(preSetCEtherBalance.sub(cEtherFlows));
        expect(postRedeemerUsdcBalance).to.eq(preRedeemerUsdcBalance.sub(usdcFlows));
        expect(postSetUsdcBalance).to.eq(ZERO);
        expect(postExternalUsdcBalance).to.eq(preExternalUsdcBalance.add(usdcFlows));
      });
    });

    context("when a default cToken position and liquidated borrow position", async () => {
      let issueQuantity: BigNumber;

      cacheBeforeEach(async () => {
        cEtherUnits = BigNumber.from(5000000000);
        setToken = await setup.createSetToken(
          [cEther.address],
          [cEtherUnits],
          [compoundLeverageModule.address, debtIssuanceModule.address]
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
        await compoundLeverageModule.updateAllowedSetToken(setToken.address, true);
        await compoundLeverageModule.initialize(
          setToken.address,
          [setup.weth.address],
          [setup.usdc.address]
        );

        // Approve tokens to issuance module and call issue
        await cEther.approve(debtIssuanceModule.address, ether(1000));

        // Issue 1 SetToken
        issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Lever up
        await compoundLeverageModule.lever(
          setToken.address,
          setup.usdc.address,
          setup.weth.address,
          usdc(750),
          ether(0.5),
          "UniswapV2ExchangeAdapter",
          EMPTY_BYTES
        );

        // Set price to be liquidated
        const liquidationEthPrice = ether(500);
        await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, liquidationEthPrice);
        await setup.usdc.approve(cUsdc.address, MAX_UINT_256);
        const unitsToLiquidate = usdc(250);
        actualSeizedTokens = await compoundSetup.comptroller.liquidateCalculateSeizeTokens(
          cUsdc.address,
          cEther.address,
          unitsToLiquidate
        );

        await cUsdc.liquidateBorrow(setToken.address, unitsToLiquidate, cEther.address);

        await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(1000));

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

        const expectedPostLiquidationUnit = initialPositions[0].unit.sub(preciseDiv(actualSeizedTokens[1], setTotalSupply));
        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(cEther.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(expectedPostLiquidationUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();
        await compoundLeverageModule.sync(setToken.address, true);

        await subject();
        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];
        const previousSecondPositionBalance = (await cUsdc.borrowBalanceStored(setToken.address)).mul(-1);
        const setTotalSupply = await setToken.totalSupply();

        const newSecondPositionNotional = preciseMul(newSecondPosition.unit, setTotalSupply);
        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component).to.eq(setup.usdc.address);
        expect(newSecondPosition.positionState).to.eq(1); // External
        expect(newSecondPositionNotional).to.eq(previousSecondPositionBalance);
        expect(newSecondPosition.module).to.eq(compoundLeverageModule.address);
      });

      it("should have the correct token balances", async () => {
        const preRedeemerCEtherBalance = await cEther.balanceOf(subjectCaller.address);
        const preSetCEtherBalance = await cEther.balanceOf(subjectSetToken);
        const preRedeemerUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const preExternalUsdcBalance = await setup.usdc.balanceOf(cUsdc.address);

        await subject();

        const redeemQuantity = preciseMul(subjectQuantity, ether(1).sub(redeemFee));
        const newCEtherPositionUnits = (await setToken.getPositions())[0].unit;
        const cEtherFlows = preciseMul(redeemQuantity, newCEtherPositionUnits);

        const debtPositionUnits = (await setToken.getPositions())[1].unit;
        const usdcFlows = preciseMulCeil(redeemQuantity, debtPositionUnits.mul(-1));

        const postRedeemerCEtherBalance = await cEther.balanceOf(subjectCaller.address);
        const postSetCEtherBalance = await cEther.balanceOf(subjectSetToken);
        const postRedeemerUsdcBalance = await setup.usdc.balanceOf(subjectCaller.address);
        const postSetUsdcBalance = await setup.usdc.balanceOf(subjectSetToken);
        const postExternalUsdcBalance = await setup.usdc.balanceOf(cUsdc.address);

        expect(postRedeemerCEtherBalance).to.eq(preRedeemerCEtherBalance.add(cEtherFlows));
        expect(postSetCEtherBalance).to.eq(preSetCEtherBalance.sub(cEtherFlows));
        expect(postRedeemerUsdcBalance).to.eq(preRedeemerUsdcBalance.sub(usdcFlows));
        expect(postSetUsdcBalance).to.eq(ZERO);
        expect(postExternalUsdcBalance).to.eq(preExternalUsdcBalance.add(usdcFlows));
      });
    });
  });
});
