import "module-alias/register";

import { BigNumber } from "ethers";

import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  EMPTY_BYTES,
  ZERO,
} from "@utils/constants";
import { UniswapV2IndexExchangeAdapter } from "@utils/contracts";
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

describe("UniswapV2IndexExchangeAdapter", () => {
  let owner: Account;
  let mockSetToken: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;
  let uniswapSetup: UniswapFixture;

  let uniswapV2ExchangeAdapter: UniswapV2IndexExchangeAdapter;

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

    uniswapV2ExchangeAdapter = await deployer.adapters.deployUniswapV2IndexExchangeAdapter(uniswapSetup.router.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("constructor", async () => {
    let subjectUniswapRouter: Address;

    beforeEach(async () => {
      subjectUniswapRouter = uniswapSetup.router.address;
    });

    async function subject(): Promise<any> {
      return await deployer.adapters.deployUniswapV2IndexExchangeAdapter(subjectUniswapRouter);
    }

    it("should have the correct router address", async () => {
      const deployedUniswapV2IndexExchangeAdapter = await subject();

      const actualRouterAddress = await deployedUniswapV2IndexExchangeAdapter.router();
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
    let sourceToken: Address;
    let destinationToken: Address;
    let sourceQuantity: BigNumber;
    let destinationQuantity: BigNumber;

    let subjectMockSetToken: Address;
    let subjectSourceToken: Address;
    let subjectDestinationToken: Address;
    let subjectIsSendTokenFixed: boolean;
    let subjectSourceQuantity: BigNumber;
    let subjectDestinationQuantity: BigNumber;
    let subjectData: Bytes;

    beforeEach(async () => {
      sourceToken = setup.wbtc.address;          // WBTC Address
      sourceQuantity = BigNumber.from(100000000);  // Trade 1 WBTC
      destinationToken = setup.dai.address;      // DAI Address
      destinationQuantity = ether(30000);          // Receive at least 30k DAI

      subjectSourceToken = sourceToken;
      subjectDestinationToken = destinationToken;
      subjectMockSetToken = mockSetToken.address;
      subjectIsSendTokenFixed = true;
      subjectSourceQuantity = sourceQuantity;
      subjectDestinationQuantity = destinationQuantity;
      subjectData = EMPTY_BYTES;
    });

    async function subject(): Promise<any> {
      return await uniswapV2ExchangeAdapter.getTradeCalldata(
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
        const expectedCallData = uniswapSetup.router.interface.encodeFunctionData("swapExactTokensForTokens", [
          sourceQuantity,
          destinationQuantity,
          [sourceToken, destinationToken],
          subjectMockSetToken,
          callTimestamp,
        ]);
        expect(JSON.stringify(calldata)).to.eq(JSON.stringify([uniswapSetup.router.address, ZERO, expectedCallData]));
      });

      context("when an intermediate token is provided", async () => {

        beforeEach(() => {
          subjectData = setup.weth.address;
        });

        it("should return the correct trade calldata", async () => {
          const calldata = await subject();
          const callTimestamp = await getLastBlockTimestamp();
          const expectedCallData = uniswapSetup.router.interface.encodeFunctionData("swapExactTokensForTokens", [
            sourceQuantity,
            destinationQuantity,
            [sourceToken, setup.weth.address, destinationToken],
            subjectMockSetToken,
            callTimestamp,
          ]);
          expect(JSON.stringify(calldata)).to.eq(JSON.stringify([uniswapSetup.router.address, ZERO, expectedCallData]));
        });
      });
    });

    context("when boolean to swap exact tokens for tokens is false", async () => {
      beforeEach(async () => {
        subjectIsSendTokenFixed = false;
      });

      it("should return the correct trade calldata", async () => {
        const calldata = await subject();
        const callTimestamp = await getLastBlockTimestamp();
        const expectedCallData = uniswapSetup.router.interface.encodeFunctionData("swapTokensForExactTokens", [
          destinationQuantity, // Source and destination quantity are flipped for swapTokensForExactTokens
          sourceQuantity,
          [sourceToken, destinationToken],
          subjectMockSetToken,
          callTimestamp,
        ]);
        expect(JSON.stringify(calldata)).to.eq(JSON.stringify([uniswapSetup.router.address, ZERO, expectedCallData]));
      });

      context("when an intermediate token is provided", async () => {

        beforeEach(() => {
          subjectData = setup.weth.address;
        });

        it("should return the correct trade calldata", async () => {
          const calldata = await subject();
          const callTimestamp = await getLastBlockTimestamp();
          const expectedCallData = uniswapSetup.router.interface.encodeFunctionData("swapTokensForExactTokens", [
            destinationQuantity,
            sourceQuantity,
            [sourceToken, setup.weth.address, destinationToken],
            subjectMockSetToken,
            callTimestamp,
          ]);
          expect(JSON.stringify(calldata)).to.eq(JSON.stringify([uniswapSetup.router.address, ZERO, expectedCallData]));
        });
      });
    });
  });
});
