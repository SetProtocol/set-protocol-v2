import "module-alias/register";

import { BigNumber, BigNumberish } from "ethers";
import { solidityPack } from "ethers/lib/utils";

import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import { ZERO } from "@utils/constants";
import { UniswapV3ExchangeAdapter } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getWaffleExpect,
  getLastBlockTimestamp,
  getUniswapV3Fixture,
  getRandomAddress
} from "@utils/test/index";

import { SystemFixture, UniswapV3Fixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("UniswapV3ExchangeAdapter", () => {
  let owner: Account;
  let mockSetToken: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;
  let uniswapV3Fixture: UniswapV3Fixture;

  let uniswapV3ExchangeAdapter: UniswapV3ExchangeAdapter;

  before(async () => {
    [
      owner,
      mockSetToken,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    uniswapV3Fixture = getUniswapV3Fixture(owner.address);
    await uniswapV3Fixture.initialize(
      owner,
      setup.weth,
      2500,
      setup.wbtc,
      35000,
      setup.dai
    );

    uniswapV3ExchangeAdapter = await deployer.adapters.deployUniswapV3ExchangeAdapter(uniswapV3Fixture.swapRouter.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectSwapRouter: Address;

    beforeEach(async () => {
      subjectSwapRouter = uniswapV3Fixture.swapRouter.address;
    });

    async function subject(): Promise<any> {
      return await deployer.adapters.deployUniswapV3ExchangeAdapter(subjectSwapRouter);
    }

    it("should have the correct SwapRouter address", async () => {
      const deployedUniswapV3ExchangeAdapter = await subject();

      const actualRouterAddress = await deployedUniswapV3ExchangeAdapter.swapRouter();
      expect(actualRouterAddress).to.eq(uniswapV3Fixture.swapRouter.address);
    });
  });

  describe("#getSpender", async () => {
    async function subject(): Promise<any> {
      return await uniswapV3ExchangeAdapter.getSpender();
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();

      expect(spender).to.eq(uniswapV3Fixture.swapRouter.address);
    });
  });

  describe("#getTradeCalldata", async () => {

    let subjectMockSetToken: Address;
    let subjectSourceToken: Address;
    let subjectDestinationToken: Address;
    let subjectSourceQuantity: BigNumber;
    let subjectMinDestinationQuantity: BigNumber;
    let subjectPath: Bytes;

    beforeEach(async () => {
      subjectSourceToken = setup.wbtc.address;
      subjectSourceQuantity = BigNumber.from(100000000);
      subjectDestinationToken = setup.weth.address;
      subjectMinDestinationQuantity = ether(25);

      subjectMockSetToken = mockSetToken.address;

      subjectPath = solidityPack(["address", "uint24", "address"], [subjectSourceToken, BigNumber.from(3000), subjectDestinationToken]);
    });

    async function subject(): Promise<any> {
      return await uniswapV3ExchangeAdapter.getTradeCalldata(
        subjectSourceToken,
        subjectDestinationToken,
        subjectMockSetToken,
        subjectSourceQuantity,
        subjectMinDestinationQuantity,
        subjectPath,
      );
    }

    it("should return the correct trade calldata", async () => {
      const calldata = await subject();
      const callTimestamp = await getLastBlockTimestamp();

      const expectedCallData = uniswapV3Fixture.swapRouter.interface.encodeFunctionData("exactInput", [{
        path: subjectPath,
        recipient: mockSetToken.address,
        deadline: callTimestamp,
        amountIn: subjectSourceQuantity,
        amountOutMinimum: subjectMinDestinationQuantity,
      }]);

      expect(JSON.stringify(calldata)).to.eq(JSON.stringify([uniswapV3Fixture.swapRouter.address, ZERO, expectedCallData]));
    });

    context("when source token does not match path", async () => {
      beforeEach(async () => {
        subjectSourceToken = await getRandomAddress();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("UniswapV3ExchangeAdapter: source token path mismatch");
      });
    });

    context("when destination token does not match path", async () => {
      beforeEach(async () => {
        subjectDestinationToken = await getRandomAddress();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("UniswapV3ExchangeAdapter: destination token path mismatch");
      });
    });
  });

  describe("#generateDataParam", async () => {

    let subjectToken1: Address;
    let subjectFee1: BigNumberish;
    let subjectToken2: Address;
    let subjectFee2: BigNumberish;
    let subjectToken3: Address;

    beforeEach(async () => {
      subjectToken1 = setup.wbtc.address;
      subjectFee1 = 3000;
      subjectToken2 = setup.weth.address;
      subjectFee2 = 500;
      subjectToken3 = setup.weth.address;
    });

    async function subject(): Promise<string> {
      return await uniswapV3ExchangeAdapter.generateDataParam([subjectToken1, subjectToken2, subjectToken3], [subjectFee1, subjectFee2]);
    }

    it("should create the correct path data", async () => {
      const data = await subject();

      const expectedData = solidityPack(
        ["address", "uint24", "address", "uint24", "address"],
        [subjectToken1, subjectFee1, subjectToken2, subjectFee2, subjectToken3]
      );

      expect(data).to.eq(expectedData);
    });
  });
});
