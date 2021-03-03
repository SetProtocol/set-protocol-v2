import "module-alias/register";

import { BigNumber } from "@ethersproject/bignumber";
import { defaultAbiCoder } from "ethers/lib/utils";

import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  EMPTY_BYTES,
  ZERO,
} from "@utils/constants";
import { UniswapV2ExchangeAdapterV2 } from "@utils/contracts";
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

describe("UniswapV2ExchangeAdapterV2", () => {
  let owner: Account;
  let mockSetToken: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;
  let uniswapSetup: UniswapFixture;

  let uniswapV2ExchangeAdapter: UniswapV2ExchangeAdapterV2;

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

    uniswapV2ExchangeAdapter = await deployer.adapters.deployUniswapV2ExchangeAdapterV2(uniswapSetup.router.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("constructor", async () => {
    let subjectUniswapRouter: Address;

    beforeEach(async () => {
      subjectUniswapRouter = uniswapSetup.router.address;
    });

    async function subject(): Promise<any> {
      return await deployer.adapters.deployUniswapV2ExchangeAdapterV2(subjectUniswapRouter);
    }

    it("should have the correct router address", async () => {
      const deployedUniswapV2ExchangeAdapterV2 = await subject();

      const actualRouterAddress = await deployedUniswapV2ExchangeAdapterV2.router();
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

  describe("getUniswapExchangeData", async () => {
    let subjectPath: Address[];
    let subjectShouldTradeForExact: boolean;

    beforeEach(async () => {
      subjectPath = [setup.weth.address, setup.wbtc.address, setup.dai.address];
      subjectShouldTradeForExact = true;
    });

    async function subject(): Promise<any> {
      return await uniswapV2ExchangeAdapter.getUniswapExchangeData(subjectPath, subjectShouldTradeForExact);
    }

    it("should return the correct data", async () => {
      const uniswapData = await subject();
      const expectedData = defaultAbiCoder.encode(
        ["address[]", "bool"],
        [subjectPath, subjectShouldTradeForExact]
      );

      expect(uniswapData).to.eq(expectedData);
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
      destinationQuantity = ether(30000);          // Receive at least 30k DAI

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

    describe("when boolean to swap for exact tokens is false", async () => {
      beforeEach(async () => {
        const path = [sourceAddress, setup.weth.address, destinationAddress];
        const shouldTradeForExact = false;
        subjectData = defaultAbiCoder.encode(
          ["address[]", "bool"],
          [path, shouldTradeForExact]
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

    describe("when boolean to swap for exact tokens is true", async () => {
      beforeEach(async () => {
        const path = [sourceAddress, setup.weth.address, destinationAddress];
        const shouldTradeForExact = true;
        subjectData = defaultAbiCoder.encode(
          ["address[]", "bool"],
          [path, shouldTradeForExact]
        );
      });

      it("should return the correct trade calldata", async () => {
        const calldata = await subject();
        const callTimestamp = await getLastBlockTimestamp();
        const expectedCallData = uniswapSetup.router.interface.encodeFunctionData("swapTokensForExactTokens", [
          destinationQuantity, // Source and destination quantity are flipped for swapTokensForExactTokens
          sourceQuantity,
          [sourceAddress, setup.weth.address, destinationAddress],
          subjectMockSetToken,
          callTimestamp,
        ]);
        expect(JSON.stringify(calldata)).to.eq(JSON.stringify([uniswapSetup.router.address, ZERO, expectedCallData]));
      });
    });
  });
});
