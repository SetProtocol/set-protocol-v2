import "module-alias/register";

import { BigNumber } from "ethers";
import { utils } from "ethers";

import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  EMPTY_BYTES,
  ZERO,
} from "@utils/constants";
import { UniswapV2ExchangeAdapter } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
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

describe("UniswapV2ExchangeAdapter", () => {
  let owner: Account;
  let mockSetToken: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;
  let uniswapSetup: UniswapFixture;

  let uniswapV2ExchangeAdapter: UniswapV2ExchangeAdapter;

  before(async () => {
    [
      owner,
      mockSetToken,
    ] = await getAccounts();

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

    uniswapV2ExchangeAdapter = await deployer.adapters.deployUniswapV2ExchangeAdapter(uniswapSetup.router.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("constructor", async () => {
    let subjectUniswapRouter: Address;

    beforeEach(async () => {
      subjectUniswapRouter = uniswapSetup.router.address;
    });

    async function subject(): Promise<any> {
      return await deployer.adapters.deployUniswapV2ExchangeAdapter(subjectUniswapRouter);
    }

    it("should have the correct router address", async () => {
      const deployedUniswapV2ExchangeAdapter = await subject();

      const actualRouterAddress = await deployedUniswapV2ExchangeAdapter.router();
      expect(actualRouterAddress).to.eq(uniswapSetup.router.address);
    });
  });

  describe("getSpender", async () => {
    async function subject(): Promise<any> {
      return await uniswapV2ExchangeAdapter.getSpender();
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();

      expect(spender).to.eq(uniswapSetup.router.address);
    });
  });

  describe("getTradeCalldata", async () => {
    let sourceAddress: Address;
    let destinationAddress: Address;
    let sourceQuantity: BigNumber;
    let destinationQuantity: BigNumber;

    let subjectMockSetToken: Address;
    let subjectSourceToken: Address;
    let subjectDestinationToken: Address;
    let subjectSourceQuantity: BigNumber;
    let subjectMinDestinationQuantity: BigNumber;
    let subjectData: Bytes;

    beforeEach(async () => {
      sourceAddress = setup.wbtc.address;          // WBTC Address
      sourceQuantity = BigNumber.from(100000000);  // Trade 1 WBTC
      destinationAddress = setup.dai.address;      // DAI Address
      destinationQuantity = ether(30000);         // Receive at least 30k DAI

      subjectSourceToken = sourceAddress;
      subjectDestinationToken = destinationAddress;
      subjectMockSetToken = mockSetToken.address;
      subjectSourceQuantity = sourceQuantity;
      subjectMinDestinationQuantity = destinationQuantity;
      subjectData = EMPTY_BYTES;
    });

    async function subject(): Promise<any> {
      return await uniswapV2ExchangeAdapter.getTradeCalldata(
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
      const expectedCallData = uniswapSetup.router.interface.encodeFunctionData("swapExactTokensForTokens", [
        sourceQuantity,
        destinationQuantity,
        [sourceAddress, destinationAddress],
        subjectMockSetToken,
        callTimestamp,
      ]);
      expect(JSON.stringify(calldata)).to.eq(JSON.stringify([uniswapSetup.router.address, ZERO, expectedCallData]));
    });

    describe("when passed in custom path to trade data", async () => {
      beforeEach(async () => {
        const path = [sourceAddress, setup.weth.address, destinationAddress];
        subjectData = utils.defaultAbiCoder.encode(
          ["address[]"],
          [path]
        );
      });

      it("should return the correct trade calldata", async () => {
        const calldata = await subject();
        const callTimestamp = await getLastBlockTimestamp();
        const expectedCallData = uniswapSetup.router.interface.encodeFunctionData("swapExactTokensForTokens", [
          sourceQuantity,
          destinationQuantity,
          [sourceAddress, setup.weth.address, destinationAddress],
          subjectMockSetToken,
          callTimestamp,
        ]);
        expect(JSON.stringify(calldata)).to.eq(JSON.stringify([uniswapSetup.router.address, ZERO, expectedCallData]));
      });
    });
  });
});
