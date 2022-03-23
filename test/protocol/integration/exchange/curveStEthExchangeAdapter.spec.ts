import "module-alias/register";

import { BigNumber } from "ethers";
import { solidityPack } from "ethers/lib/utils";

import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import { ETH_ADDRESS } from "@utils/constants";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getWaffleExpect,
  getRandomAddress,
} from "@utils/test/index";

import { SystemFixture } from "@utils/fixtures";
import { CurveStEthExchangeAdapter } from "@utils/contracts";
import { CurveEthStEthExchange } from "@utils/contracts/curve";

import { StandardTokenMock } from "@typechain/StandardTokenMock";

const expect = getWaffleExpect();

describe("CurveStEthExchangeAdapter", () => {
  let owner: Account;
  let mockSetToken: Account;
  let mockPoolToken: Account;
  let stEth: StandardTokenMock;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let exchange: CurveEthStEthExchange;
  let adapter: CurveStEthExchangeAdapter;

  before(async () => {
    [owner, mockSetToken, mockPoolToken] = await getAccounts();

    stEth = await deployer.mocks.deployTokenMock(owner.address);

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    exchange = await deployer.external.deployCurveEthStEthExchange(
      owner.address,
      [ETH_ADDRESS, stEth.address],
      mockPoolToken.address,
    );

    adapter = await deployer.adapters.deployCurveStEthExchangeAdapter(
      setup.weth.address,
      stEth.address,
      exchange.address,
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectWeth: Address;
    let subjectSteth: Address;
    let subjectExchangeAddress: Address;

    beforeEach(async () => {
      subjectExchangeAddress = exchange.address;
    });

    async function subject(): Promise<CurveStEthExchangeAdapter> {
      return await deployer.adapters.deployCurveStEthExchangeAdapter(
        subjectWeth,
        subjectSteth,
        subjectExchangeAddress,
      );
    }
    it("should have the correct weth address", async () => {
      const adapter = await subject();
      console.log(adapter);
    });

    it("should have the correct steth address", async () => {});

    it("should have the correct exchange address", async () => {});
  });

  describe("#getSpender", async () => {
    async function subject(): Promise<any> {
      return await adapter.getSpender();
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();

      expect(spender).to.eq(adapter.address);
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

      subjectPath = solidityPack(
        ["address", "uint24", "address"],
        [subjectSourceToken, BigNumber.from(3000), subjectDestinationToken],
      );
    });

    async function subject(): Promise<any> {
      return await adapter.getTradeCalldata(
        subjectSourceToken,
        subjectDestinationToken,
        subjectMockSetToken,
        subjectSourceQuantity,
        subjectMinDestinationQuantity,
        subjectPath,
      );
    }

    it("should return the correct trade calldata", async () => {
    //   const calldata = await subject();
    //   const callTimestamp = await getLastBlockTimestamp();

      //   const expectedCallData = uniswapV3Fixture.swapRouter.interface.encodeFunctionData("exactInput", [{
      //     path: subjectPath,
      //     recipient: mockSetToken.address,
      //     deadline: callTimestamp,
      //     amountIn: subjectSourceQuantity,
      //     amountOutMinimum: subjectMinDestinationQuantity,
      //   }]);

      //   expect(JSON.stringify(calldata)).to.eq(JSON.stringify([uniswapV3Fixture.swapRouter.address, ZERO, expectedCallData]));
    });

    context("when source token does not match path", async () => {
      beforeEach(async () => {
        subjectSourceToken = await getRandomAddress();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith(
          "UniswapV3ExchangeAdapter: source token path mismatch",
        );
      });
    });

    context("when destination token does not match path", async () => {
      beforeEach(async () => {
        subjectDestinationToken = await getRandomAddress();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith(
          "UniswapV3ExchangeAdapter: destination token path mismatch",
        );
      });
    });
  });

  describe("#buyStEth", async () => {
    beforeEach(async () => {});
    it("should buy stEth", async () => {});
  });

  describe("#sellStEth", async () => {
    beforeEach(async () => {});
    it("should sellStEth", async () => {});
  });
});
