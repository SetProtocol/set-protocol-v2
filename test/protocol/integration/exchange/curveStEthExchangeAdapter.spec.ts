import "module-alias/register";

import { BigNumber, ContractTransaction } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { EMPTY_BYTES, ETH_ADDRESS, MAX_UINT_256 } from "@utils/constants";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getWaffleExpect,
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

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    stEth = await deployer.mocks.deployTokenMock(owner.address);

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

    await stEth.connect(owner.wallet).approve(adapter.address, MAX_UINT_256);
    await setup.weth.connect(owner.wallet).approve(adapter.address, MAX_UINT_256);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectWeth: Address;
    let subjectSteth: Address;
    let subjectExchangeAddress: Address;

    beforeEach(async () => {
      subjectWeth = setup.weth.address;
      subjectSteth = stEth.address;
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

    async function subject(): Promise<string> {
      return await adapter.getTradeCalldata(
        subjectSourceToken,
        subjectDestinationToken,
        subjectMockSetToken,
        subjectSourceQuantity,
        subjectMinDestinationQuantity,
        EMPTY_BYTES,
      );
    }

    context("when buying stETH with weth", async () => {
      beforeEach(async () => {
        subjectSourceToken = setup.weth.address;
        subjectSourceQuantity = BigNumber.from(100000000);
        subjectDestinationToken = stEth.address;
        subjectMinDestinationQuantity = ether(25);

        subjectMockSetToken = mockSetToken.address;
      });

      it("should return the correct trade calldata", async () => {
        const calldata = await subject();

        const expectedCallData = adapter.interface.encodeFunctionData("buyStEth", [
          subjectSourceQuantity,
          subjectMinDestinationQuantity,
          subjectMockSetToken,
        ]);

        expect(calldata).to.eq(expectedCallData);
      });
    });

    context("when buying weth with stETH", async () => {
      beforeEach(async () => {
        subjectSourceToken = stEth.address;
        subjectSourceQuantity = BigNumber.from(100000000);
        subjectDestinationToken = setup.weth.address;
        subjectMinDestinationQuantity = ether(25);

        subjectMockSetToken = mockSetToken.address;
      });

      it("should return the correct trade calldata", async () => {
        const calldata = await subject();

        const expectedCallData = adapter.interface.encodeFunctionData("sellStEth", [
          subjectSourceQuantity,
          subjectMinDestinationQuantity,
          subjectMockSetToken,
        ]);

        expect(calldata).to.eq(expectedCallData);
      });
    });
  });

  describe("#buyStEth", async () => {
    let subjectDestinationToken: Address;
    let subjectSourceQuantity: BigNumber;
    let subjectMinDestinationQuantity: BigNumber;

    beforeEach(async () => {
      subjectSourceQuantity = BigNumber.from(100000000);
      subjectMinDestinationQuantity = ether(25);
      subjectDestinationToken = mockSetToken.address;
    });

    async function subject(): Promise<ContractTransaction> {
      return await adapter.connect(owner.wallet).buyStEth(
        subjectSourceQuantity,
        subjectMinDestinationQuantity,
        subjectDestinationToken
      );
    }

    it("should buy stEth", async () => {
      const previousStEthBalance = await stEth.balanceOf(subjectDestinationToken);
      const previousWethBalance = await setup.weth.balanceOf(owner.address);
      expect(previousStEthBalance).to.eq(0);
      expect(previousWethBalance).to.eq(ether(5000));

      await subject();

      const afterStEthBalance = stEth.balanceOf(subjectDestinationToken);
      const afterWethBalance = setup.weth.balanceOf(owner.address);
      expect(afterStEthBalance).to.eq(subjectMinDestinationQuantity);
      expect(afterWethBalance).to.eq(0);
    });
  });

  describe("#sellStEth", async () => {
    let subjectDestinationToken: Address;
    let subjectSourceQuantity: BigNumber;
    let subjectMinDestinationQuantity: BigNumber;

    beforeEach(async () => {
      subjectSourceQuantity = BigNumber.from(100000000);
      subjectMinDestinationQuantity = ether(25);
      subjectDestinationToken = mockSetToken.address;
    });

    async function subject(): Promise<ContractTransaction> {
      return await adapter.connect(owner.wallet).sellStEth(
        subjectSourceQuantity,
        subjectMinDestinationQuantity,
        subjectDestinationToken
      );
    }

    it("should sell stEth", async () => {
      const previousStEthBalance = await stEth.balanceOf(owner.address);
      const previousWethBalance = await setup.weth.balanceOf(subjectDestinationToken);
      expect(previousStEthBalance).to.eq(ether(1000000000));
      expect(previousWethBalance).to.eq(0);

      await subject();

      const afterStEthBalance = stEth.balanceOf(owner.address);
      const afterWethBalance = setup.weth.balanceOf(subjectDestinationToken);
      expect(afterStEthBalance).to.eq(0);
      expect(afterWethBalance).to.eq(subjectMinDestinationQuantity);
    });
  });
});
