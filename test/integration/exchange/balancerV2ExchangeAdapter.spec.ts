import "module-alias/register";

import { BigNumber } from "ethers";
import { ethers } from "hardhat";

import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import { BalancerV2ExchangeAdapter, IERC20 } from "@typechain/index";
import {
  SetToken,
  TradeModule,
  ManagerIssuanceHookMock,
} from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
} from "@utils/index";
import {
  cacheBeforeEach,
  getAccounts,
  getSystemFixture,
  getWaffleExpect,
  getForkedTokens,
  initializeForkedTokens,
  ForkedTokens
} from "@utils/test/index";

import { SystemFixture } from "@utils/fixtures";
import { ZERO } from "@utils/constants";

const expect = getWaffleExpect();

describe("BalancerV2ExchangeAdapter TradeModule Integration [ @forked-mainnet ]", () => {

  const balancerVaultAddress = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
  const poolId = "0x1e19cf2d73a72ef1332c882f20534b6519be0276000200000000000000000112";

  let owner: Account;
  let manager: Account;

  let deployer: DeployHelper;

  let balancerV2ExchangeAdapter: BalancerV2ExchangeAdapter;
  let balancerV2AdapterName: string;

  let setup: SystemFixture;
  let tradeModule: TradeModule;
  let tokens: ForkedTokens;

  before(async () => {
    [
      owner,
      manager,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    balancerV2ExchangeAdapter = await deployer.adapters.deployBalancerV2ExchangeAdapter(balancerVaultAddress);
    balancerV2AdapterName = "BALANCERV2";

    tradeModule = await deployer.modules.deployTradeModule(setup.controller.address);
    await setup.controller.addModule(tradeModule.address);

    await setup.integrationRegistry.addIntegration(
      tradeModule.address,
      balancerV2AdapterName,
      balancerV2ExchangeAdapter.address
    );

    await initializeForkedTokens(deployer);
  });

  describe("#trade", function() {
    let sourceToken: IERC20;
    let destinationToken: IERC20;
    let setToken: SetToken;
    let issueQuantity: BigNumber;

    context("when trading a component using BalancerV2 exchange adapter", async () => {
      let mockPreIssuanceHook: ManagerIssuanceHookMock;

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

        sourceToken = tokens.reth;
        destinationToken = tokens.weth;

        // Create Set token
        setToken = await setup.createSetToken(
          [sourceToken.address],
          [ether(1)],
          [setup.issuanceModule.address, tradeModule.address],
          manager.address
        );

        const spender = await balancerV2ExchangeAdapter.getSpender();

        await sourceToken.approve(spender, ether(100));
        await destinationToken.approve(spender, ether(100));

        tradeModule = tradeModule.connect(manager.wallet);
        await tradeModule.initialize(setToken.address);

        // Transfer from reth whale to manager
        await sourceToken.transfer(manager.address, ether(20));

        // Approve tokens to Controller and call issue
        sourceToken = sourceToken.connect(manager.wallet);
        await sourceToken.approve(setup.issuanceModule.address, ethers.constants.MaxUint256);

        // Deploy mock issuance hook and initialize issuance module
        setup.issuanceModule = setup.issuanceModule.connect(manager.wallet);
        mockPreIssuanceHook = await deployer.mocks.deployManagerIssuanceHookMock();
        await setup.issuanceModule.initialize(setToken.address, mockPreIssuanceHook.address);

        issueQuantity = ether(5);
        await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);
      });

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectSourceToken = sourceToken.address;
        subjectDestinationToken = destinationToken.address;
        subjectSourceQuantity = ether(1);
        subjectMinDestinationQuantity = ether(1); // assume almost 1:1
        subjectAdapterName = balancerV2AdapterName;
        subjectData = poolId;
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
        const beforeSourceTokenBalance = await sourceToken.balanceOf(subjectSetToken);
        expect(beforeSourceTokenBalance).to.eq(ether(5));

        await subject();

        const afterSourceTokenBalance = await sourceToken.balanceOf(subjectSetToken);
        expect(afterSourceTokenBalance).to.eq(ZERO);
      });

      it("should transfer the correct components from the SetToken", async () => {
        const beforeDestinationTokenBalance = await destinationToken.balanceOf(subjectSetToken);

        await subject();

        const afterDestinationTokenBalance = await destinationToken.balanceOf(subjectSetToken);
        const tradedToken = afterDestinationTokenBalance.sub(beforeDestinationTokenBalance);
        expect(tradedToken).to.be.gt(ZERO);
        // Assume almost 1:1
        expect(tradedToken).to.be.gte(ether(5));
      });
    });
  });
});
