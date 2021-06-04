import "module-alias/register";

import { hexlify, hexZeroPad } from "ethers/lib/utils";
import { BigNumber } from "@ethersproject/bignumber";
import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  ZERO,
} from "@utils/constants";
import { SwapRouter, UniswapV3Factory } from "@utils/contracts/uniswap";
import { UniswapV3IndexExchangeAdapter } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import { SystemFixture } from "@utils/fixtures";
import {
  ether,
} from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getWaffleExpect,
  getLastBlockTimestamp
} from "@utils/test/index";

const expect = getWaffleExpect();

describe("UniswapV3IndexExchangeAdapter", () => {
  let owner: Account;
  let mockSetToken: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let swapRouter: SwapRouter;
  let factory: UniswapV3Factory;
  let uniswapV3ExchangeAdapter: UniswapV3IndexExchangeAdapter;

  function constructFeesData(_poolFeesPercentage: BigNumber): Bytes {
    return hexZeroPad(hexlify(_poolFeesPercentage), 3);
  }

  before(async () => {
    [
      owner,
      mockSetToken,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setup = getSystemFixture(owner.address);
    await setup.initialize();

    factory = await deployer.external.deployUniswapV3Factory();
    swapRouter = await deployer.external.deploySwapRouter(factory.address, setup.weth.address);

    uniswapV3ExchangeAdapter = await deployer.adapters.deployUniswapV3IndexExchangeAdapter(swapRouter.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("constructor", async () => {
    let subjectRouterAddress: Address;

    beforeEach(async () => {
      subjectRouterAddress = swapRouter.address;
    });

    async function subject(): Promise<any> {
      return await deployer.adapters.deployUniswapV3IndexExchangeAdapter(subjectRouterAddress);
    }

    it("should have the correct router address", async () => {
      const deployedUniswapV3IndexExchangeAdapter = await subject();

      const routerAddress = await deployedUniswapV3IndexExchangeAdapter.router();
      const expectedRouterAddress = subjectRouterAddress;

      expect(routerAddress).to.eq(expectedRouterAddress);
    });
  });

  describe("getSpender", async () => {
    async function subject(): Promise<any> {
      return await uniswapV3ExchangeAdapter.getSpender();
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();
      const expectedSpender = swapRouter.address;

      expect(spender).to.eq(expectedSpender);
    });
  });

  describe("getTradeCalldata", async () => {
    let sourceToken: Address;
    let destinationToken: Address;
    let sourceQuantity: BigNumber;
    let destinationQuantity: BigNumber;
    let poolFeesPercentage: BigNumber;

    let subjectMockSetToken: Address;
    let subjectSourceToken: Address;
    let subjectDestinationToken: Address;
    let subjectIsSendTokenFixed: boolean;
    let subjectSourceQuantity: BigNumber;
    let subjectDestinationQuantity: BigNumber;
    let subjectData: Bytes;

    beforeEach(async () => {
      sourceToken = setup.wbtc.address;            // WBTC Address
      sourceQuantity = BigNumber.from(100000000);  // Trade 1 WBTC
      destinationToken = setup.dai.address;        // DAI Address
      destinationQuantity = ether(50000);          // Receive at least 50k DAI
      poolFeesPercentage = BigNumber.from(3000);   // 0.3% fee

      subjectSourceToken = sourceToken;
      subjectDestinationToken = destinationToken;
      subjectMockSetToken = mockSetToken.address;
      subjectIsSendTokenFixed = true;
      subjectSourceQuantity = sourceQuantity;
      subjectDestinationQuantity = destinationQuantity;
      subjectData = constructFeesData(poolFeesPercentage);
    });

    async function subject(): Promise<any> {
      return await uniswapV3ExchangeAdapter.getTradeCalldata(
        subjectSourceToken,
        subjectDestinationToken,
        subjectMockSetToken,
        subjectIsSendTokenFixed,
        subjectSourceQuantity,
        subjectDestinationQuantity,
        subjectData,
      );
    }

    describe("when boolean to swap exact tokens for tokens is true", async () => {
      it("should return the correct trade calldata", async () => {
        const [tragetAddress, ethValue, callData] = await subject();

        const callTimestamp = await getLastBlockTimestamp();

        const expectedCallData = swapRouter.interface.encodeFunctionData("exactInputSingle", [{
          tokenIn: sourceToken,
          tokenOut: destinationToken,
          fee: poolFeesPercentage,
          recipient: subjectMockSetToken,
          deadline: callTimestamp,
          amountIn: sourceQuantity,
          amountOutMinimum: destinationQuantity,
          sqrtPriceLimitX96: 0,
        }]);

        expect(tragetAddress).to.eq(swapRouter.address);
        expect(ethValue).to.eq(ZERO);
        expect(callData).to.eq(expectedCallData);
      });
    });

    describe("when boolean to swap exact tokens for tokens is false", async () => {
      beforeEach(async () => {
        subjectIsSendTokenFixed = false;
      });

      it("should return the correct trade calldata", async () => {
        const [tragetAddress, ethValue, callData] = await subject();

        const callTimestamp = await getLastBlockTimestamp();

        const expectedCallData = swapRouter.interface.encodeFunctionData("exactOutputSingle", [{
          tokenIn: sourceToken,
          tokenOut: destinationToken,
          fee: poolFeesPercentage,
          recipient: subjectMockSetToken,
          deadline: callTimestamp,
          amountOut: destinationQuantity,
          amountInMaximum: sourceQuantity,
          sqrtPriceLimitX96: 0,
        }]);

        expect(tragetAddress).to.eq(swapRouter.address);
        expect(ethValue).to.eq(ZERO);
        expect(callData).to.eq(expectedCallData);
      });
    });
  });
});