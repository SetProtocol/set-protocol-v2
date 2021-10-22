import "module-alias/register";
import { BigNumber } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ADDRESS_ZERO, MAX_UINT_256, ZERO } from "@utils/constants";
import {
  GeneralIndexModule,
  SetToken,
  UniswapV2IndexExchangeAdapter
} from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  bitcoin,
  ether,
  preciseDiv,
  preciseMul,
} from "@utils/index";
import {
  cacheBeforeEach,
  getAccounts,
  getSystemFixture,
  getUniswapFixture,
  getWaffleExpect
} from "@utils/test/index";
import { SystemFixture, UniswapFixture } from "@utils/fixtures";
import { ContractTransaction } from "ethers";

const expect = getWaffleExpect();

describe("UniswapV2ExchangeGeneralIndexModule", () => {
  let owner: Account;
  let trader: Account;
  let positionModule: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let uniswapSetup: UniswapFixture;

  let index: SetToken;
  let indexModule: GeneralIndexModule;

  let exchangeAdapter: UniswapV2IndexExchangeAdapter;
  let exchangeAdapterName: string;

  let indexComponents: Address[];
  let indexUnits: BigNumber[];

  before(async () => {
    [
      owner,
      trader,
      positionModule,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    uniswapSetup = getUniswapFixture(owner.address);

    await setup.initialize();
    await uniswapSetup.initialize(owner, setup.weth.address, setup.wbtc.address, setup.dai.address);

    indexModule = await deployer.modules.deployGeneralIndexModule(
      setup.controller.address,
      setup.weth.address
    );
    await setup.controller.addModule(indexModule.address);
    await setup.controller.addModule(positionModule.address);


    exchangeAdapter = await deployer.adapters.deployUniswapV2IndexExchangeAdapter(uniswapSetup.router.address);
    exchangeAdapterName = "UniswapV2ExchangeAdapter";


    await setup.integrationRegistry.batchAddIntegration(
      [ indexModule.address ],
      [ exchangeAdapterName ],
      [ exchangeAdapter.address ]
    );
  });

  cacheBeforeEach(async () => {
    indexComponents = [setup.wbtc.address, setup.dai.address];
    indexUnits = [ bitcoin(0.01), ether(4000) ];

    index = await setup.createSetToken(
      indexComponents,
      indexUnits,
      [setup.issuanceModule.address, indexModule.address, positionModule.address],
    );

    await setup.issuanceModule.initialize(index.address, ADDRESS_ZERO);
    await index.connect(positionModule.wallet).initializeModule();

    await setup.weth.connect(owner.wallet).approve(uniswapSetup.router.address, MAX_UINT_256);
    await setup.dai.connect(owner.wallet).approve(uniswapSetup.router.address, MAX_UINT_256);
    await setup.wbtc.connect(owner.wallet).approve(uniswapSetup.router.address, MAX_UINT_256);

    await uniswapSetup.router.connect(owner.wallet).addLiquidity(
      setup.weth.address,
      setup.dai.address,
      ether(200),
      ether(400000),
      ether(0),
      ether(0),
      owner.address,
      MAX_UINT_256
    );

    await uniswapSetup.router.connect(owner.wallet).addLiquidity(
      setup.wbtc.address,
      setup.dai.address,
      bitcoin(2),
      ether(80000),
      ether(0),
      ether(0),
      owner.address,
      MAX_UINT_256
    );

    await uniswapSetup.router.connect(owner.wallet).addLiquidity(
      setup.wbtc.address,
      setup.weth.address,
      bitcoin(20),
      ether(800),
      ether(0),
      ether(0),
      owner.address,
      MAX_UINT_256
    );

    await uniswapSetup.router.addLiquidity(
      setup.weth.address,
      setup.wbtc.address,
      ether(1000),
      bitcoin(25.5555),
      ether(0),
      ether(0),
      owner.address,
      MAX_UINT_256
    );
  });

  describe("when module is initalized", async () => {
    let subjectSetToken: SetToken;
    let subjectCaller: Account;

    let newComponents: Address[];
    let newTargetUnits: BigNumber[];
    let oldTargetUnits: BigNumber[];
    let issueAmount: BigNumber;

    async function initSetToken(
      setToken: SetToken, components: Address[], tradeMaximums: BigNumber[], exchanges: string[], coolOffPeriods: BigNumber[]
    ) {
      await indexModule.initialize(setToken.address);
      await indexModule.setTradeMaximums(setToken.address, components, tradeMaximums);
      await indexModule.setExchanges(setToken.address, components, exchanges);
      await indexModule.setCoolOffPeriods(setToken.address, components, coolOffPeriods);
      await indexModule.setTraderStatus(setToken.address, [trader.address], [true]);
    }

    const startRebalance = async () => {
      await setup.approveAndIssueSetToken(subjectSetToken, issueAmount);
      await indexModule.startRebalance(
        subjectSetToken.address,
        newComponents,
        newTargetUnits,
        oldTargetUnits,
        await index.positionMultiplier()
      );
    };

    before(async () => {
      newComponents = [];
      oldTargetUnits = [bitcoin(0.1), ether(1)];
      newTargetUnits = [];
      issueAmount = ether("20.000000000000000001");
    });

    cacheBeforeEach(async () => {
      await initSetToken(
        index,
        [setup.wbtc.address, setup.dai.address],
        [bitcoin(1000), ether(100000)],
        [exchangeAdapterName, exchangeAdapterName],
        [ZERO, ZERO]
      );
    });

    describe("#trade", async () => {
      let subjectComponent: Address;
      let subjectEthQuantityLimit: BigNumber;

      let expectedOut: BigNumber;

      const initializeSubjectVariables = () => {
        subjectSetToken = index;
        subjectCaller = trader;
        subjectComponent = setup.dai.address;
        subjectEthQuantityLimit = ZERO;
      };

      async function subject(): Promise<ContractTransaction> {
        return await indexModule.connect(subjectCaller.wallet).trade(
          subjectSetToken.address,
          subjectComponent,
          subjectEthQuantityLimit
        );
      }

      context("when trading without an intermediary component", async () => {
        beforeEach(async () => {
          initializeSubjectVariables();

          expectedOut = (await uniswapSetup.router.getAmountsOut(
            preciseMul(ether(3999), issueAmount),
            [ setup.dai.address, setup.weth.address ]
          ))[1];

          subjectEthQuantityLimit = BigNumber.from(0);
        });
        cacheBeforeEach(startRebalance);

        it("should sell using Uniswap V2", async () => {
          const currentWethAmount = await setup.weth.balanceOf(subjectSetToken.address);
          const totalSupply = await subjectSetToken.totalSupply();

          await subject();

          const expectedWethPositionUnits = preciseDiv(currentWethAmount.add(expectedOut), totalSupply);
          const expectedDaiPositionUnits = ether(1);

          const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
          const daiPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.dai.address);

          expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
          expect(daiPositionUnits).to.eq(expectedDaiPositionUnits);
        });
      });

      context("when trading with an intermediary component", async () => {
        beforeEach(async () => {
          initializeSubjectVariables();

          const exchangeData = setup.wbtc.address;
          await indexModule.setExchangeData(subjectSetToken.address, [setup.dai.address], [exchangeData]);

          expectedOut = (await uniswapSetup.router.getAmountsOut(
            preciseMul(ether(3999), issueAmount),
            [ setup.dai.address, setup.wbtc.address, setup.weth.address ]
          ))[2];

          subjectEthQuantityLimit = BigNumber.from(0);
        });
        cacheBeforeEach(startRebalance);

        it("should sell using Uniswap V2", async () => {
          const currentWethAmount = await setup.weth.balanceOf(subjectSetToken.address);
          const totalSupply = await subjectSetToken.totalSupply();

          await subject();

          const expectedWethPositionUnits = preciseDiv(currentWethAmount.add(expectedOut), totalSupply);
          const expectedDaiPositionUnits = ether(1);

          const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
          const daiPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.dai.address);

          expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
          expect(daiPositionUnits).to.eq(expectedDaiPositionUnits);
        });
      });
    });

    describe("#tradeRemainingWETH", async () => {

      let subjectComponent: Address;
      let subjectEthQuantityLimit: BigNumber;

      let expectedOut: BigNumber;

      const initializeSubjectVariables = () => {
        subjectSetToken = index;
        subjectCaller = trader;
        subjectComponent = setup.dai.address;
        subjectEthQuantityLimit = ZERO;
      };

      async function subject(): Promise<ContractTransaction> {
        return await indexModule.connect(subjectCaller.wallet).tradeRemainingWETH(
          subjectSetToken.address,
          subjectComponent,
          subjectEthQuantityLimit
        );
      }

      context("when using default target units", async () => {

        beforeEach(async () => {
          initializeSubjectVariables();
        });
        cacheBeforeEach(startRebalance);

        context("when trading without an intermediary component", async () => {

          beforeEach(async () => {
            await indexModule.connect(subjectCaller.wallet).trade(
              subjectSetToken.address,
              subjectComponent,
              subjectEthQuantityLimit
            );

            expectedOut = (await uniswapSetup.router.getAmountsOut(
              await setup.weth.balanceOf(subjectSetToken.address),
              [ setup.weth.address, setup.wbtc.address ]
            ))[1];

            subjectComponent = setup.wbtc.address;
            subjectEthQuantityLimit = ZERO;
          });

          it("should buy using UniswapV2", async () => {
            const currentWbtcAmount = await setup.wbtc.balanceOf(subjectSetToken.address);
            const totalSupply = await subjectSetToken.totalSupply();

            await subject();

            const expectedWbtcPositionUnits = preciseDiv(currentWbtcAmount.add(expectedOut), totalSupply);
            const expectedWethPositionUnits = ether(0);

            const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
            const wbtcPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.wbtc.address);

            expect(wbtcPositionUnits).to.eq(expectedWbtcPositionUnits);
            expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
          });
        });

        context("when trading with an intermediary component", async () => {

          beforeEach(async () => {
            await indexModule.connect(subjectCaller.wallet).trade(
              subjectSetToken.address,
              subjectComponent,
              subjectEthQuantityLimit
            );

            const exchangeData = setup.dai.address;
            await indexModule.setExchangeData(subjectSetToken.address, [setup.wbtc.address], [exchangeData]);

            expectedOut = (await uniswapSetup.router.getAmountsOut(
              await setup.weth.balanceOf(subjectSetToken.address),
              [ setup.weth.address, setup.dai.address, setup.wbtc.address ]
            ))[2];

            subjectComponent = setup.wbtc.address;
            subjectEthQuantityLimit = ZERO;
          });

          it("should buy using UniswapV2", async () => {
            const currentWbtcAmount = await setup.wbtc.balanceOf(subjectSetToken.address);
            const totalSupply = await subjectSetToken.totalSupply();

            await subject();

            const expectedWbtcPositionUnits = preciseDiv(currentWbtcAmount.add(expectedOut), totalSupply);
            const expectedWethPositionUnits = ether(0);

            const wethPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.weth.address);
            const wbtcPositionUnits = await subjectSetToken.getDefaultPositionRealUnit(setup.wbtc.address);

            expect(wbtcPositionUnits).to.eq(expectedWbtcPositionUnits);
            expect(wethPositionUnits).to.eq(expectedWethPositionUnits);
          });
        });
      });
    });
  });
});
