import "module-alias/register";

import { BigNumber } from "@ethersproject/bignumber";
import { ethers } from "hardhat";

import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import { IERC20 } from "@typechain/index";
import {
  SetToken,
  TradeModule,
  ManagerIssuanceHookMock,
  ZeroExMock,
  ZeroExApiAdapter,
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

const expect = getWaffleExpect();

describe("ZeroExExchangeTradeModule [ @forked-mainnet ]", () => {
  let owner: Account;
  let manager: Account;

  let deployer: DeployHelper;

  let zeroExExchange: ZeroExMock;
  let zeroExApiAdapter: ZeroExApiAdapter;
  let zeroExApiAdapterName: string;

  let setup: SystemFixture;
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

    wbtcRate = ether(29); // 1 WBTC = 29 ETH

    // Forked ZeroEx exchange
    zeroExExchange = await deployer.mocks.getForkedZeroExExchange();

    zeroExApiAdapter = await deployer.adapters.deployZeroExApiAdapter(zeroExExchange.address);
    zeroExApiAdapterName = "ZERO_EX";

    tradeModule = await deployer.modules.deployTradeModule(setup.controller.address);
    await setup.controller.addModule(tradeModule.address);

    await setup.integrationRegistry.addIntegration(
      tradeModule.address,
      zeroExApiAdapterName,
      zeroExApiAdapter.address
    );

    await initializeForkedTokens(deployer);
  });

  describe("#trade", function() {
    let sourceToken: IERC20;
    let wbtcUnits: BigNumber;
    let destinationToken: IERC20;
    let setToken: SetToken;
    let issueQuantity: BigNumber;
    let destinationTokenQuantity: BigNumber;

    context("when trading a Default component on 0xAPI", async () => {
      let mockPreIssuanceHook: ManagerIssuanceHookMock;
      let sourceTokenQuantity: BigNumber;

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

        tradeModule = tradeModule.connect(manager.wallet);
        await tradeModule.initialize(setToken.address);

        sourceTokenQuantity = wbtcUnits;
        const sourceTokenDecimals = 8;
        const denominator = BigNumber.from(10).pow(sourceTokenDecimals);
        destinationTokenQuantity = wbtcRate.mul(sourceTokenQuantity).div(denominator);

        // Transfer from wbtc treasury to manager
        await sourceToken.transfer(manager.address, wbtcUnits.mul(2));

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
        subjectAdapterName = zeroExApiAdapterName;
        // Encode function data. Inputs are unused in the mock One Inch contract
        subjectData = zeroExExchange.interface.encodeFunctionData("transformERC20", [
          sourceToken.address, // Send token
          destinationToken.address, // Receive token
          sourceTokenQuantity, // Send quantity
          destinationTokenQuantity.sub(ether(1)), // Min receive quantity
          [],
        ]);
        subjectMinDestinationQuantity = destinationTokenQuantity.sub(ether(1)); // Receive a min of 28 WETH for 1 WBTC
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

      // Tests error with:
      // TransactionExecutionError: Number can only safely store up to 53 bits
      //    at HardhatNode.mineBlock (...hardhat-network/provider/node.ts:327:13)
      it.skip("should transfer the correct components to the SetToken", async () => {
        const oldDestinationTokenBalance = await destinationToken.balanceOf(setToken.address);

        await subject();

        const totalDestinationQuantity = issueQuantity.mul(destinationTokenQuantity).div(ether(1));
        const expectedDestinationTokenBalance = oldDestinationTokenBalance.add(totalDestinationQuantity);
        const newDestinationTokenBalance = await destinationToken.balanceOf(setToken.address);
        expect(newDestinationTokenBalance).to.eq(expectedDestinationTokenBalance);
      });

      it.skip("should transfer the correct components from the SetToken", async () => {
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
