import "module-alias/register";

import { BigNumber } from "@ethersproject/bignumber";

import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  EMPTY_BYTES,
  ZERO,
} from "@utils/constants";
import { TradeSplitter, TradeSplitterIndexExchangeAdapter } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  bitcoin,
  ether,
} from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getUniswapFixture,
  getWaffleExpect,
  getLastBlockTimestamp
} from "@utils/test/index";

import { SystemFixture, UniswapFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("TradeSplitterIndexExchangeAdapter", () => {
  let owner: Account;
  let mockSetToken: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let uniswapSetup: UniswapFixture;
  let sushiswapSetup: UniswapFixture;
  let tradeSplitter: TradeSplitter;

  let tradeSplitterIndexExchangeAdapter: TradeSplitterIndexExchangeAdapter;

  before(async () => {

    [ owner, mockSetToken ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

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

    tradeSplitter = await deployer.product.deployTradeSplitter(uniswapSetup.router.address, sushiswapSetup.router.address);
    tradeSplitterIndexExchangeAdapter = await deployer.adapters.deployTradeSplitterIndexExchangeAdapter(tradeSplitter.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {

    let subjectTradeSplitter: Address;

    beforeEach(async () => {
      subjectTradeSplitter = tradeSplitter.address;
    });

    async function subject(): Promise<TradeSplitterIndexExchangeAdapter> {
      return await deployer.adapters.deployTradeSplitterIndexExchangeAdapter(subjectTradeSplitter);
    }

    it("should have the correct router address", async () => {
      const deployedTradeSplitterIndexExchangeAdapter = await subject();

      const actualTradeSplitterAddress = await deployedTradeSplitterIndexExchangeAdapter.tradeSplitter();
      expect(actualTradeSplitterAddress).to.eq(subjectTradeSplitter);
    });
  });

  describe("#getSpender", async () => {
    async function subject(): Promise<string> {
      return await tradeSplitterIndexExchangeAdapter.getSpender();
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();

      expect(spender).to.eq(tradeSplitter.address);
    });
  });

  describe("#getTradeCalldata", async () => {

    let subjectMockSetToken: Address;
    let subjectSourceToken: Address;
    let subjectDestinationToken: Address;
    let subjectIsSendTokenFixed: boolean;
    let subjectSourceQuantity: BigNumber;
    let subjectDestinationQuantity: BigNumber;
    let subjectData: Bytes;

    beforeEach(async () => {
      subjectSourceToken = setup.wbtc.address;
      subjectDestinationToken = setup.dai.address;
      subjectMockSetToken = mockSetToken.address;
      subjectIsSendTokenFixed = true;
      subjectSourceQuantity = bitcoin(1);
      subjectDestinationQuantity = ether(40000);
      subjectData = EMPTY_BYTES;
    });

    async function subject(): Promise<any> {
      return await tradeSplitterIndexExchangeAdapter.getTradeCalldata(
        subjectSourceToken,
        subjectDestinationToken,
        subjectMockSetToken,
        subjectIsSendTokenFixed,
        subjectSourceQuantity,
        subjectDestinationQuantity,
        subjectData,
      );
    }

    context("when boolean to swap exact tokens for tokens is true", async () => {

      it("should return the correct trade calldata", async () => {
        const calldata = await subject();

        const callTimestamp = await getLastBlockTimestamp();
        const expectedCallData = tradeSplitter.interface.encodeFunctionData("tradeExactInput", [
          subjectSourceQuantity,
          subjectDestinationQuantity,
          [subjectSourceToken, subjectDestinationToken],
          subjectMockSetToken,
          callTimestamp,
        ]);

        expect(JSON.stringify(calldata)).to.eq(JSON.stringify([tradeSplitter.address, ZERO, expectedCallData]));
      });
    });

    context("when boolean to swap exact tokens for tokens is false", async () => {

      beforeEach(async () => {
        subjectIsSendTokenFixed = false;
      });

      it("should return the correct trade calldata", async () => {
        const calldata = await subject();

        const callTimestamp = await getLastBlockTimestamp();
        const expectedCallData = tradeSplitter.interface.encodeFunctionData("tradeExactOutput", [
          subjectSourceQuantity,
          subjectDestinationQuantity,
          [subjectSourceToken, subjectDestinationToken],
          subjectMockSetToken,
          callTimestamp,
        ]);

        expect(JSON.stringify(calldata)).to.eq(JSON.stringify([tradeSplitter.address, ZERO, expectedCallData]));
      });
    });
  });
});
