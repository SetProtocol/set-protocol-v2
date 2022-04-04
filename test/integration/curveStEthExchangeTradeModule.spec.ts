import "module-alias/register";

import { BigNumber } from "ethers";

import { Address } from "@utils/types";
import { Account, ForkedTokens } from "@utils/test/types";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAaveV2Fixture,
  getAccounts,
  getCurveFixture,
  getForkedTokens,
  getRandomAccount,
  getSystemFixture,
  getWaffleExpect,
  initializeForkedTokens,
} from "@utils/test/index";

// import {
// AaveV2AToken,
// AaveV2VariableDebtToken,
// } from "@utils/contracts/aaveV2";
import { AaveV2Fixture, CurveFixture, SystemFixture } from "@utils/fixtures";
import {
  AaveLeverageModule,
  CurveStEthExchangeAdapter,
  CurveStEthStableswapMock,
  TradeModule,
  SetToken,
  WETH9,
} from "@utils/contracts";

import { StandardTokenMock } from "@typechain/StandardTokenMock";
import dependencies from "@utils/deploys/dependencies";
import { IERC20 } from "@typechain/IERC20";
import { EMPTY_BYTES, MAX_UINT_256, ZERO } from "@utils/constants";

const expect = getWaffleExpect();

/**
 * Tests the icETH rebalance flow.
 *
 * The icETH product is a composite product composed of:
 * 1. stETH
 * 2. WETH
 */
describe("CurveStEthExchangeAdapter TradeModule integration [ @forked-mainnet ]", () => {
  let owner: Account;
  let manager: Account;

  let deployer: DeployHelper;

  let adapter: CurveStEthExchangeAdapter;
  let adapterName: string;

  let setup: SystemFixture;
  let aaveSetup: AaveV2Fixture;
  let curveSetup: CurveFixture;
  let stableswap: CurveStEthStableswapMock;
  let tradeModule: TradeModule;
  let aaveLeverageModule: AaveLeverageModule;
  let tokens: ForkedTokens;

  let weth: WETH9;
  let stEth: StandardTokenMock;
  // let aWETH: AaveV2AToken;
  // let astEth: AaveV2AToken;
  // let variableDebtWETH: AaveV2VariableDebtToken;

  before(async () => {
    [owner, manager] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    await initializeForkedTokens(deployer);

    setup = getSystemFixture(owner.address);
    await setup.initialize();

    curveSetup = getCurveFixture(owner.address);

    aaveSetup = getAaveV2Fixture(owner.address);
    await aaveSetup.initialize(setup.weth.address, setup.dai.address);

    weth = setup.weth;
    stEth = await deployer.mocks.getTokenMock(dependencies.STETH[1]);

    stableswap = await curveSetup.getForkedCurveStEthStableswapPool();

    adapter = await deployer.adapters.deployCurveStEthExchangeAdapter(
      weth.address,
      stEth.address,
      stableswap.address,
    );
    adapterName = "CurveStEthExchangeAdapter";

    tradeModule = await deployer.modules.deployTradeModule(setup.controller.address);
    await setup.controller.addModule(tradeModule.address);

    await setup.integrationRegistry.addIntegration(
      tradeModule.address,
      adapterName,
      adapter.address,
    );

    await initializeForkedTokens(deployer);

    tokens = getForkedTokens();

    // Setup AAVE lending pools
    // Create a stETH reserve
    await aaveSetup.createAndEnableReserve(
      stEth.address, "stETH", BigNumber.from(18),
      BigNumber.from(8000),   // base LTV: 80%
      BigNumber.from(8250),   // liquidation threshold: 82.5%
      BigNumber.from(10500),  // liquidation bonus: 105.00%
      BigNumber.from(1000),   // reserve factor: 10%
      true,                   // enable borrowing on reserve
      true                    // enable stable debts
    );

    // astEth = reserveTokens.aToken;

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

    await tokens.steth.transfer(ape.address, ether(50000));
    await tokens.steth.connect(ape.wallet).approve(aaveSetup.lendingPool.address, ether(50000));
    await aaveSetup.lendingPool.connect(ape.wallet).deposit(
      stEth.address,
      ether(50),
      ape.address,
      ZERO
    );

    // aWETH = aaveSetup.wethReserveTokens.aToken;
    // variableDebtWETH = aaveSetup.wethReserveTokens.variableDebtToken;

    const aaveV2Library = await deployer.libraries.deployAaveV2();
    aaveLeverageModule = await deployer.modules.deployAaveLeverageModule(
      setup.controller.address,
      aaveSetup.lendingPoolAddressesProvider.address,
      "contracts/protocol/integration/lib/AaveV2.sol:AaveV2",
      aaveV2Library.address,
    );
    await setup.controller.addModule(aaveLeverageModule.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#trade", async () => {
    let sourceToken: IERC20;
    let destinationToken: IERC20;
    let setToken: SetToken;
    let issueQuantity: BigNumber;

    async function initialize() {
      // Create Set token
      setToken = await setup.createSetToken(
        [stEth.address],
        [ether(1)],
        [setup.issuanceModule.address, tradeModule.address, aaveLeverageModule.address],
        manager.address,
      );

      await stEth.connect(owner.wallet).approve(stableswap.address, MAX_UINT_256);
      await weth.connect(owner.wallet).approve(stableswap.address, MAX_UINT_256);

      tradeModule = tradeModule.connect(manager.wallet);
      await tradeModule.initialize(setToken.address);

      await tokens.steth.transfer(owner.address, ether(10));
      await tokens.weth.transfer(owner.address, ether(10));

      // Transfer some untracked steth to set token to overcollaterize the position
      await tokens.steth.transfer(setToken.address, ether(0.1));

      // Approve tokens to Controller and call issue
      await stEth.connect(owner.wallet).approve(setup.issuanceModule.address, MAX_UINT_256);
      await weth
        .connect(owner.wallet)
        .approve(setup.issuanceModule.address, MAX_UINT_256);

      // Deploy mock issuance hook and initialize issuance module
      const mockPreIssuanceHook = await deployer.mocks.deployManagerIssuanceHookMock();
      await setup.issuanceModule.connect(manager.wallet).initialize(setToken.address, mockPreIssuanceHook.address);

      issueQuantity = ether(1);
      await setup.issuanceModule.connect(owner.wallet).issue(setToken.address, issueQuantity, owner.address);
    }

    context("when trading stETH for WETH on CurveStEthExchangeAdapter", async () => {
      let subjectDestinationToken: Address;
      let subjectSourceToken: Address;
      let subjectSourceQuantity: BigNumber;
      let subjectAdapterName: string;
      let subjectSetToken: Address;
      let subjectMinDestinationQuantity: BigNumber;
      let subjectData: string;
      let subjectCaller: Account;

      beforeEach(async () => {
        sourceToken = tokens.steth;
        destinationToken = tokens.weth;

        await initialize();

        subjectSourceToken = sourceToken.address;
        subjectDestinationToken = destinationToken.address;
        subjectSourceQuantity = ether(1);
        subjectAdapterName = adapterName;
        subjectSetToken = setToken.address;
        subjectMinDestinationQuantity = ether(1);
        const tradeCalldata = await adapter.getTradeCalldata(
          subjectSourceToken,
          subjectDestinationToken,
          subjectSetToken,
          subjectSourceQuantity,
          subjectMinDestinationQuantity,
          EMPTY_BYTES,
        );
        subjectData = tradeCalldata[2];
        subjectCaller = manager;
      });

      async function subject(): Promise<any> {
        return tradeModule
          .connect(subjectCaller.wallet)
          .trade(
            subjectSetToken,
            subjectAdapterName,
            subjectSourceToken,
            subjectSourceQuantity,
            subjectDestinationToken,
            subjectMinDestinationQuantity,
            subjectData,
          );
      }

      it("should trade all stETH for WETH", async () => {
        await expect(subject()).to.be.reverted;
      });
    });

    context("when trading WETH for stETH on CurveStEthExchangeAdapter", async () => {
      let subjectDestinationToken: Address;
      let subjectSourceToken: Address;
      let subjectSourceQuantity: BigNumber;
      let subjectAdapterName: string;
      let subjectSetToken: Address;
      let subjectMinDestinationQuantity: BigNumber;
      let subjectData: string;
      let subjectCaller: Account;

      beforeEach(async () => {
        sourceToken = tokens.weth;
        destinationToken = tokens.steth;

        await initialize();

        subjectDestinationToken = destinationToken.address;
        subjectSourceToken = sourceToken.address;
        subjectSourceQuantity = ether(1);
        subjectAdapterName = adapterName;
        subjectSetToken = setToken.address;
        subjectMinDestinationQuantity = ether(1);
        const tradeCalldata = await adapter.getTradeCalldata(
          subjectSourceToken,
          subjectDestinationToken,
          subjectSetToken,
          subjectSourceQuantity,
          subjectMinDestinationQuantity,
          EMPTY_BYTES,
        );
        subjectData = tradeCalldata[2];
        subjectCaller = manager;
      });

      async function subject(): Promise<any> {
        return tradeModule
          .connect(subjectCaller.wallet)
          .trade(
            subjectSetToken,
            subjectAdapterName,
            subjectSourceToken,
            subjectSourceQuantity,
            subjectDestinationToken,
            subjectMinDestinationQuantity,
            subjectData,
          );
      }

      it("should trade all WETH for STETH", async () => {
        await subject();
      });
    });
  });
});
