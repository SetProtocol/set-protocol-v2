import "module-alias/register";

import { BigNumber } from "ethers";

import { Address } from "@utils/types";
import { Account, ForkedTokens } from "@utils/test/types";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getCurveFixture,
  getForkedTokens,
  getSystemFixture,
  getWaffleExpect,
  initializeForkedTokens,
} from "@utils/test/index";

import { CurveFixture, SystemFixture } from "@utils/fixtures";
import {
  CurveStEthExchangeAdapter,
  CurveStEthStableswapMock,
  TradeModule,
  SetToken,
  WETH9,
} from "@utils/contracts";

import { StandardTokenMock } from "@typechain/StandardTokenMock";
import dependencies from "@utils/deploys/dependencies";
import { IERC20 } from "@typechain/IERC20";
import { EMPTY_BYTES, MAX_UINT_256 } from "@utils/constants";

const expect = getWaffleExpect();

describe("CurveStEthExchangeAdapter TradeModule integration [ @forked-mainnet ]", () => {
  let owner: Account;
  let manager: Account;

  let deployer: DeployHelper;

  let adapter: CurveStEthExchangeAdapter;
  let adapterName: string;

  let setup: SystemFixture;
  let curveSetup: CurveFixture;
  let stableswap: CurveStEthStableswapMock;
  let tradeModule: TradeModule;
  let tokens: ForkedTokens;

  let weth: WETH9;
  let stEth: StandardTokenMock;

  before(async () => {
    [owner, manager] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    await initializeForkedTokens(deployer);

    setup = getSystemFixture(owner.address);
    await setup.initialize();

    weth = setup.weth;
    stEth = await deployer.mocks.getTokenMock(dependencies.STETH[1]);

    curveSetup = getCurveFixture(owner.address);
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
        [sourceToken.address, destinationToken.address],
        [ether(1), ether(1)],
        [setup.issuanceModule.address, tradeModule.address],
        manager.address,
      );

      await sourceToken.approve(stableswap.address, MAX_UINT_256);
      await destinationToken.approve(stableswap.address, MAX_UINT_256);

      tradeModule = tradeModule.connect(manager.wallet);
      await tradeModule.initialize(setToken.address);

      await sourceToken.transfer(manager.address, ether(1));
      await destinationToken.transfer(manager.address, ether(1));

      // Approve tokens to Controller and call issue
      await sourceToken.connect(manager.wallet).approve(setup.issuanceModule.address, MAX_UINT_256);
      await destinationToken
        .connect(manager.wallet)
        .approve(setup.issuanceModule.address, MAX_UINT_256);

      // Deploy mock issuance hook and initialize issuance module
      setup.issuanceModule = setup.issuanceModule.connect(manager.wallet);
      const mockPreIssuanceHook = await deployer.mocks.deployManagerIssuanceHookMock();
      await setup.issuanceModule.initialize(setToken.address, mockPreIssuanceHook.address);

      issueQuantity = ether(1);
      await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);
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
