import "module-alias/register";

import { BigNumber } from "ethers";
import { ethers } from "hardhat";

import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import { IERC20, UniswapV2Router02 } from "@typechain/index";
import {
  SetToken,
  TradeModule,
  ManagerIssuanceHookMock,
  UniswapV2ExchangeAdapterV2,
} from "@utils/contracts";
import { ZERO } from "@utils/constants";
import DeployHelper from "@utils/deploys";
import {
  ether,
  bitcoin,
} from "@utils/index";
import {
  cacheBeforeEach,
  getAccounts,
  getSystemFixture,
  getWaffleExpect,
  getUniswapFixture,
  getForkedTokens,
  initializeForkedTokens,
  ForkedTokens
} from "@utils/test/index";

import { SystemFixture, UniswapFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("UniswapExchangeV2 TradeModule Integration [ @forked-mainnet ]", () => {
  let owner: Account;
  let manager: Account;

  let deployer: DeployHelper;

  let uniswapExchangeAdapterV2: UniswapV2ExchangeAdapterV2;
  let uniswapAdapterV2Name: string;

  let setup: SystemFixture;
  let uniswapSetup: UniswapFixture;
  let uniswapRouter: UniswapV2Router02;
  let tradeModule: TradeModule;
  let tokens: ForkedTokens;
  let wbtcRate: BigNumber;

  before(async () => {
    [
      owner,
      manager,
    ] = await getAccounts();


    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    wbtcRate = ether(29);

    uniswapSetup = getUniswapFixture(owner.address);
    uniswapRouter = uniswapSetup.getForkedUniswapRouter();

    uniswapExchangeAdapterV2 = await deployer.adapters.deployUniswapV2ExchangeAdapterV2(uniswapRouter.address);
    uniswapAdapterV2Name = "UNISWAPV2";

    tradeModule = await deployer.modules.deployTradeModule(setup.controller.address);
    await setup.controller.addModule(tradeModule.address);

    await setup.integrationRegistry.addIntegration(
      tradeModule.address,
      uniswapAdapterV2Name,
      uniswapExchangeAdapterV2.address
    );

    await initializeForkedTokens(deployer);
  });

  describe("#trade", function() {
    let sourceToken: IERC20;
    let wbtcUnits: BigNumber;
    let destinationToken: IERC20;
    let setToken: SetToken;
    let issueQuantity: BigNumber;

    context("when trading a Default component on Uniswap version 2 adapter", async () => {
      let mockPreIssuanceHook: ManagerIssuanceHookMock;
      let sourceTokenQuantity: BigNumber;
      let destinationTokenQuantity: BigNumber;

      let subjectDestinationToken: Address;
      let subjectSourceToken: Address;
      let subjectSourceQuantity: BigNumber;
      let subjectAdapterName: string;
      let subjectSetToken: Address;
      let subjectMinDestinationQuantity: BigNumber;
      let subjectData: Bytes;
      let subjectCaller: Account;

      cacheBeforeEach(async () => {
        tokens = getForkedTokens();

        sourceToken = tokens.wbtc;
        destinationToken = tokens.weth;
        wbtcUnits = BigNumber.from(100000000); // 1 WBTC in base units 1 * 10 ** 8

        // Create Set token
        setToken = await setup.createSetToken(
          [sourceToken.address],
          [wbtcUnits],
          [setup.issuanceModule.address, tradeModule.address],
          manager.address
        );

        await sourceToken.approve(uniswapRouter.address, bitcoin(100));
        await destinationToken.approve(uniswapRouter.address, ether(3400));

        tradeModule = tradeModule.connect(manager.wallet);
        await tradeModule.initialize(setToken.address);

        sourceTokenQuantity = wbtcUnits;
        const sourceTokenDecimals = 8;
        destinationTokenQuantity = wbtcRate.mul(sourceTokenQuantity).div(10 ** sourceTokenDecimals);

        // Transfer from wbtc whale to manager
        await sourceToken.transfer(manager.address, wbtcUnits.mul(1));

        // Approve tokens to Controller and call issue
        sourceToken = sourceToken.connect(manager.wallet);
        await sourceToken.approve(setup.issuanceModule.address, ethers.constants.MaxUint256);

        // Deploy mock issuance hook and initialize issuance module
        setup.issuanceModule = setup.issuanceModule.connect(manager.wallet);
        mockPreIssuanceHook = await deployer.mocks.deployManagerIssuanceHookMock();
        await setup.issuanceModule.initialize(setToken.address, mockPreIssuanceHook.address);

        issueQuantity = ether(1);
        await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);
      });

      beforeEach(async () => {
        subjectSourceToken = sourceToken.address;
        subjectDestinationToken = destinationToken.address;
        subjectSourceQuantity = sourceTokenQuantity;
        subjectSetToken = setToken.address;
        subjectMinDestinationQuantity = destinationTokenQuantity.sub(ether(1)); // Receive a min of 28 WETH for 1 WBTC
        subjectAdapterName = uniswapAdapterV2Name;

        const tradePath = [subjectSourceToken, subjectDestinationToken];
        const shouldSwapExactTokenForToken = true;

        subjectData = await uniswapExchangeAdapterV2.getUniswapExchangeData(
          tradePath,
          shouldSwapExactTokenForToken
        );
        subjectCaller = manager;
      });

      async function subject(): Promise<any> {
        tradeModule = tradeModule.connect(subjectCaller.wallet);
        return tradeModule.trade(
          subjectSetToken,
          subjectAdapterName,
          subjectSourceToken,
          subjectSourceQuantity,
          subjectDestinationToken,
          subjectMinDestinationQuantity,
          subjectData
        );
      }

      it("should transfer the correct components to the SetToken", async () => {
        const oldDestinationTokenBalance = await destinationToken.balanceOf(setToken.address);
        const [, expectedReceiveQuantity] = await uniswapRouter.getAmountsOut(
          subjectSourceQuantity,
          [subjectSourceToken, subjectDestinationToken]
        );

        await subject();

        const expectedDestinationTokenBalance = oldDestinationTokenBalance.add(expectedReceiveQuantity);
        const newDestinationTokenBalance = await destinationToken.balanceOf(setToken.address);
        expect(expectedReceiveQuantity).to.be.gt(ZERO);
        expect(newDestinationTokenBalance).to.eq(expectedDestinationTokenBalance);
      });

      it("should transfer the correct components from the SetToken", async () => {
        const oldSourceTokenBalance = await sourceToken.balanceOf(setToken.address);

        await subject();

        const totalSourceQuantity = issueQuantity.mul(sourceTokenQuantity).div(ether(1));
        const expectedSourceTokenBalance = oldSourceTokenBalance.sub(totalSourceQuantity);
        const newSourceTokenBalance = await sourceToken.balanceOf(setToken.address);
        expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
      });
    });
  });
});
