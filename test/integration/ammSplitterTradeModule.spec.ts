import "module-alias/register";
import { BigNumber, utils } from "ethers";
import { ethers } from "hardhat";

import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  ManagerIssuanceHookMock,
  SetToken,
  StandardTokenMock,
  TradeModule,
  WETH9,
  AMMSplitter,
  UniswapV2ExchangeAdapter,
} from "@utils/contracts";
import { ADDRESS_ZERO, EMPTY_BYTES, MAX_UINT_256 } from "@utils/constants";
import DeployHelper from "@utils/deploys";
import {
  ether,
  bitcoin,
} from "@utils/index";
import {
  cacheBeforeEach,
  getAccounts,
  getSystemFixture,
  getUniswapFixture,
  getWaffleExpect,
} from "@utils/test/index";

import { SystemFixture, UniswapFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("AMMSplitterTradeModule", () => {
  let owner: Account;
  let manager: Account;

  let deployer: DeployHelper;

  let tradeSplitterExchangeAdapter: UniswapV2ExchangeAdapter;
  let tradeSplitterAdapterName: string;

  let wbtcRate: BigNumber;
  let setup: SystemFixture;
  let uniswapSetup: UniswapFixture;
  let sushiswapSetup: UniswapFixture;
  let tradeSplitter: AMMSplitter;
  let tradeModule: TradeModule;

  cacheBeforeEach(async () => {
    [
      owner,
      manager,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    wbtcRate = ether(33); // 1 WBTC = 33 ETH

    uniswapSetup = getUniswapFixture(owner.address);
    await uniswapSetup.initialize(
      owner,
      setup.weth.address,
      setup.wbtc.address,
      setup.dai.address
    );

    sushiswapSetup = getUniswapFixture(owner.address);
    await sushiswapSetup.initialize(
      owner,
      setup.weth.address,
      setup.wbtc.address,
      setup.dai.address
    );

    tradeSplitter = await deployer.product.deployAMMSplitter(
      uniswapSetup.router.address,
      sushiswapSetup.router.address,
      uniswapSetup.factory.address,
      sushiswapSetup.factory.address
    );

    tradeSplitterExchangeAdapter = await deployer.adapters.deployUniswapV2ExchangeAdapter(tradeSplitter.address);
    tradeSplitterAdapterName = "TRADESPLITTER";

    tradeModule = await deployer.modules.deployTradeModule(setup.controller.address);
    await setup.controller.addModule(tradeModule.address);

    await setup.integrationRegistry.addIntegration(
      tradeModule.address,
      tradeSplitterAdapterName,
      tradeSplitterExchangeAdapter.address
    );
  });

  context("when there is a deployed SetToken with enabled TradeModule", async () => {
    let sourceToken: StandardTokenMock;
    let wbtcUnits: BigNumber;
    let destinationToken: WETH9;
    let setToken: SetToken;
    let issueQuantity: BigNumber;
    let mockPreIssuanceHook: ManagerIssuanceHookMock;

    cacheBeforeEach(async () => {
      // Selling WBTC
      sourceToken = setup.wbtc;
      destinationToken = setup.weth;
      wbtcUnits = BigNumber.from(100000000); // 1 WBTC in base units 1 * 10 ** 8

      // Create Set token
      setToken = await setup.createSetToken(
        [sourceToken.address],
        [wbtcUnits],
        [setup.issuanceModule.address, tradeModule.address],
        manager.address
      );
    });

    describe("#trade", async () => {
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

      context("when trading a Default component on TradeSplitter", async () => {
        cacheBeforeEach(async () => {

          await setup.weth.connect(owner.wallet).approve(uniswapSetup.router.address, ether(340));
          await setup.wbtc.connect(owner.wallet).approve(uniswapSetup.router.address, bitcoin(10));
          await setup.weth.connect(owner.wallet).approve(sushiswapSetup.router.address, ether(340));
          await setup.wbtc.connect(owner.wallet).approve(sushiswapSetup.router.address, bitcoin(10));

          await uniswapSetup.router.addLiquidity(
            setup.weth.address,
            setup.wbtc.address,
            ether(340),
            bitcoin(10),
            ether(335),
            ether(9.9),
            owner.address,
            MAX_UINT_256
          );
          await sushiswapSetup.router.addLiquidity(
            setup.weth.address,
            setup.wbtc.address,
            ether(340),
            bitcoin(10),
            ether(339),
            ether(9.9),
            owner.address,
            MAX_UINT_256
          );

          tradeModule = tradeModule.connect(manager.wallet);
          await tradeModule.initialize(setToken.address);

          sourceTokenQuantity = wbtcUnits;
          const sourceTokenDecimals = await sourceToken.decimals();
          destinationTokenQuantity = wbtcRate.mul(sourceTokenQuantity).div(10 ** sourceTokenDecimals);

          // Transfer sourceToken from owner to manager for issuance
          sourceToken = sourceToken.connect(owner.wallet);
          await sourceToken.transfer(manager.address, wbtcUnits.mul(100));

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

        beforeEach(() => {
          subjectSourceToken = sourceToken.address;
          subjectDestinationToken = destinationToken.address;
          subjectSourceQuantity = sourceTokenQuantity;
          subjectSetToken = setToken.address;
          subjectAdapterName = tradeSplitterAdapterName;
          subjectData = EMPTY_BYTES;
          subjectMinDestinationQuantity = destinationTokenQuantity.sub(ether(1)); // Receive a min of 32 WETH for 1 WBTC
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

          const expectedReceiveQuantity = (await tradeSplitter.getAmountsOut(
            subjectSourceQuantity,
            [ subjectSourceToken, subjectDestinationToken ]
          ))[1];

          await subject();

          const expectedDestinationTokenBalance = oldDestinationTokenBalance.add(expectedReceiveQuantity);
          const newDestinationTokenBalance = await destinationToken.balanceOf(setToken.address);
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

        it("should update the positions on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();
          const expectedReceiveQuantity = (await tradeSplitter.getAmountsOut(
            subjectSourceQuantity,
            [ subjectSourceToken, subjectDestinationToken ]
          ))[1];

          await subject();

          // All WBTC is sold for WETH
          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];

          expect(initialPositions.length).to.eq(1);
          expect(currentPositions.length).to.eq(1);
          expect(newFirstPosition.component).to.eq(destinationToken.address);
          expect(newFirstPosition.unit).to.eq(expectedReceiveQuantity);
          expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
        });

        describe("when path is through multiple trading pairs", async () => {
          beforeEach(async () => {

            await setup.weth.connect(owner.wallet).approve(uniswapSetup.router.address, ether(30));
            await setup.dai.connect(owner.wallet).approve(uniswapSetup.router.address, ether(30000));
            await setup.weth.connect(owner.wallet).approve(sushiswapSetup.router.address, ether(30));
            await setup.dai.connect(owner.wallet).approve(sushiswapSetup.router.address, ether(30000));

            await uniswapSetup.router.addLiquidity(
              setup.weth.address,
              setup.dai.address,
              ether(30),
              ether(30000),
              ether(29),
              ether(29500),
              owner.address,
              MAX_UINT_256
            );
            await sushiswapSetup.router.addLiquidity(
              setup.weth.address,
              setup.dai.address,
              ether(30),
              ether(30000),
              ether(29),
              ether(29500),
              owner.address,
              MAX_UINT_256
            );

            subjectDestinationToken = setup.dai.address;
            const tradePath = [subjectSourceToken, setup.weth.address, subjectDestinationToken];
            subjectData = utils.defaultAbiCoder.encode(
              ["address[]"],
              [tradePath]
            );
          });

          it("should transfer the correct components to the SetToken", async () => {
            const oldDestinationTokenBalance = await setup.dai.balanceOf(setToken.address);
            const expectedReceiveQuantity = (await tradeSplitter.getAmountsOut(
              subjectSourceQuantity,
              [ subjectSourceToken, setup.weth.address, subjectDestinationToken ]
            ))[2];

            await subject();

            const expectedDestinationTokenBalance = oldDestinationTokenBalance.add(expectedReceiveQuantity);
            const newDestinationTokenBalance = await setup.dai.balanceOf(setToken.address);
            expect(newDestinationTokenBalance).to.eq(expectedDestinationTokenBalance);
          });
        });
      });
    });
  });
});
