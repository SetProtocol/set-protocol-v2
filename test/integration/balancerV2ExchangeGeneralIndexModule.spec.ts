import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ADDRESS_ZERO, EMPTY_BYTES, MAX_UINT_256, ZERO } from "@utils/constants";
import {
  GeneralIndexModule,
  SetToken,
  BalancerV2IndexExchangeAdapter
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
  getBalancerV2Fixture,
  getWaffleExpect
} from "@utils/test/index";
import { BalancerV2Fixture, SystemFixture } from "@utils/fixtures";
import { ContractTransaction } from "ethers";
import { defaultAbiCoder } from "@ethersproject/abi";

const expect = getWaffleExpect();

describe("BalancerV2ExchangeGeneralIndexModule", () => {
  let owner: Account;
  let trader: Account;
  let positionModule: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let balancerSetup: BalancerV2Fixture;

  let index: SetToken;
  let indexModule: GeneralIndexModule;

  let exchangeAdapter: BalancerV2IndexExchangeAdapter;
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
    balancerSetup = getBalancerV2Fixture(owner.address);

    await setup.initialize();
    await balancerSetup.initialize(owner, setup.weth, setup.wbtc, setup.dai);

    indexModule = await deployer.modules.deployGeneralIndexModule(
      setup.controller.address,
      setup.weth.address
    );
    await setup.controller.addModule(indexModule.address);
    await setup.controller.addModule(positionModule.address);


    exchangeAdapter = await deployer.adapters.deployBalancerV2IndexExchangeAdapter(balancerSetup.vault.address);
    exchangeAdapterName = "BalancerV2IndexExchangeAdapter";


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

    await setup.weth.connect(owner.wallet).approve(balancerSetup.vault.address, MAX_UINT_256);
    await setup.dai.connect(owner.wallet).approve(balancerSetup.vault.address, MAX_UINT_256);
    await setup.wbtc.connect(owner.wallet).approve(balancerSetup.vault.address, MAX_UINT_256);

    await balancerSetup.depositInitial(balancerSetup.wethDaiPoolId, owner, [setup.weth.address, setup.dai.address], [ether(100), ether(400_000)]);
    await balancerSetup.depositInitial(balancerSetup.wethWbtcPoolId, owner, [setup.weth.address, setup.wbtc.address], [ether(100), bitcoin(4)]);
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

      beforeEach(async () => {

        initializeSubjectVariables();

        const exchangeData = defaultAbiCoder.encode(["bytes32"], [balancerSetup.wethDaiPoolId]);
        await indexModule.setExchangeData(subjectSetToken.address, [setup.dai.address], [exchangeData]);

        expectedOut = await balancerSetup.vault.connect(owner.address).callStatic.swap(
          {
            poolId: balancerSetup.wethDaiPoolId,
            kind: 0,
            assetIn: setup.dai.address,
            assetOut: setup.weth.address,
            amount: preciseMul(ether(3999), issueAmount),
            userData: EMPTY_BYTES,
          },
          {
            sender: owner.address,
            fromInternalBalance: false,
            recipient: owner.address,
            toInternalBalance: false,
          },
          0,
          MAX_UINT_256,
        );

        subjectEthQuantityLimit = BigNumber.from(0);
      });

      cacheBeforeEach(startRebalance);

      it("should sell using Balancer V2", async () => {
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

        cacheBeforeEach(startRebalance);

        beforeEach(async () => {
          initializeSubjectVariables();

          const exchangeDataDai = defaultAbiCoder.encode(["bytes32"], [balancerSetup.wethDaiPoolId]);
          await indexModule.setExchangeData(subjectSetToken.address, [setup.dai.address], [exchangeDataDai]);

          const exchangeDataWbtc = defaultAbiCoder.encode(["bytes32"], [balancerSetup.wethWbtcPoolId]);
          await indexModule.setExchangeData(subjectSetToken.address, [setup.wbtc.address], [exchangeDataWbtc]);

          await indexModule.connect(subjectCaller.wallet).trade(
            subjectSetToken.address,
            subjectComponent,
            subjectEthQuantityLimit
          );


          expectedOut = await balancerSetup.vault.connect(owner.address).callStatic.swap(
            {
              poolId: balancerSetup.wethWbtcPoolId,
              kind: 0,
              assetIn: setup.weth.address,
              assetOut: setup.wbtc.address,
              amount: await setup.weth.balanceOf(subjectSetToken.address),
              userData: EMPTY_BYTES,
            },
            {
              sender: owner.address,
              fromInternalBalance: false,
              recipient: owner.address,
              toInternalBalance: false,
            },
            0,
            MAX_UINT_256,
          );

          subjectComponent = setup.wbtc.address;
          subjectEthQuantityLimit = ZERO;
        });

        it("should buy using Balancer V2", async () => {
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