import "module-alias/register";

import { BigNumber } from "@ethersproject/bignumber";
import { defaultAbiCoder } from "ethers/lib/utils";

import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  EMPTY_BYTES,
  ZERO,
} from "@utils/constants";
import { TradeSplitter, TradeSplitterExchangeAdapter } from "@utils/contracts";
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

describe("TradeSplitterExchangeAdapter", () => {

  let owner: Account;
  let mockSetToken: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let uniswapSetup: UniswapFixture;
  let sushiswapSetup: UniswapFixture;
  let tradeSplitter: TradeSplitter;

  let tradeSplitterExchangeAdapter: TradeSplitterExchangeAdapter;

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
    tradeSplitterExchangeAdapter = await deployer.adapters.deployTradeSplitterExchangeAdapter(tradeSplitter.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {

    let subjectTradeSplitter: Address;

    beforeEach(async () => {
      subjectTradeSplitter = tradeSplitter.address;
    });

    async function subject(): Promise<any> {
      return await deployer.adapters.deployTradeSplitterExchangeAdapter(subjectTradeSplitter);
    }

    it("should have the correct TradeSplitter address", async () => {
      const deployedTradeSplitterExchangeAdapter = await subject();

      const actualTradeSplitterAddress = await deployedTradeSplitterExchangeAdapter.tradeSplitter();
      expect(actualTradeSplitterAddress).to.eq(tradeSplitter.address);
    });
  });

  describe("#getSpender", async () => {
    async function subject(): Promise<any> {
      return await tradeSplitterExchangeAdapter.getSpender();
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
    let subjectSourceQuantity: BigNumber;
    let subjectMinDestinationQuantity: BigNumber;
    let subjectData: Bytes;

    beforeEach(async () => {
      subjectSourceToken = setup.wbtc.address;
      subjectDestinationToken = setup.dai.address;

      subjectMockSetToken = mockSetToken.address;

      subjectSourceQuantity = bitcoin(1);
      subjectMinDestinationQuantity = ether(40000);

      subjectData = EMPTY_BYTES;
    });

    async function subject(): Promise<any> {
      return await tradeSplitterExchangeAdapter.getTradeCalldata(
        subjectSourceToken,
        subjectDestinationToken,
        subjectMockSetToken,
        subjectSourceQuantity,
        subjectMinDestinationQuantity,
        subjectData,
      );
    }

    it("should return the correct trade calldata", async () => {
      const calldata = await subject();

      const callTimestamp = await getLastBlockTimestamp();
      const expectedCallData = tradeSplitter.interface.encodeFunctionData("tradeExactInput", [
        subjectSourceQuantity,
        subjectMinDestinationQuantity,
        [subjectSourceToken, subjectDestinationToken],
        subjectMockSetToken,
        callTimestamp,
      ]);

      expect(JSON.stringify(calldata)).to.eq(JSON.stringify([tradeSplitter.address, ZERO, expectedCallData]));
    });

    context("when passing in a custom path", async () => {

      beforeEach(() => {
        const path = [subjectSourceToken, setup.weth.address, subjectDestinationToken];
        subjectData = defaultAbiCoder.encode(
          ["address[]"],
          [path]
        );
      });

      it("should return the correct trade calldata", async () => {
        const calldata = await subject();

        const callTimestamp = await getLastBlockTimestamp();
        const expectedCallData = tradeSplitter.interface.encodeFunctionData("tradeExactInput", [
          subjectSourceQuantity,
          subjectMinDestinationQuantity,
          [subjectSourceToken, setup.weth.address, subjectDestinationToken],
          subjectMockSetToken,
          callTimestamp,
        ]);

        expect(JSON.stringify(calldata)).to.eq(JSON.stringify([tradeSplitter.address, ZERO, expectedCallData]));
      });
    });
  });
});
