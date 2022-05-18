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
import { CurveStEthExchangeAdapter, CurveStableswapMock } from "@utils/contracts";

import { StandardTokenMock } from "@typechain/StandardTokenMock";

const expect = getWaffleExpect();

describe("CurveStEthExchangeAdapter", () => {
  let owner: Account;
  let whale: Account;
  let mockSetToken: Account;
  let stEth: StandardTokenMock;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let stableswap: CurveStableswapMock;
  let adapter: CurveStEthExchangeAdapter;

  before(async () => {
    [owner, whale, mockSetToken] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    stEth = await deployer.mocks.deployTokenMock(owner.address);
    await stEth.connect(whale.wallet).mint(whale.address, ether(100));

    stableswap = await deployer.mocks.deployCurveStableswapMock([ETH_ADDRESS, stEth.address]);

    adapter = await deployer.adapters.deployCurveStEthExchangeAdapter(
      setup.weth.address,
      stEth.address,
      stableswap.address,
    );

    await stEth.connect(owner.wallet).approve(adapter.address, MAX_UINT_256);
    await setup.weth.connect(owner.wallet).approve(adapter.address, MAX_UINT_256);

    await stEth.connect(whale.wallet).approve(stableswap.address, MAX_UINT_256);
    await stableswap
      .connect(whale.wallet)
      .add_liquidity([ether(100), ether(100)], ether(1), { value: ether(100) });
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectWeth: Address;
    let subjectSteth: Address;
    let subjectExchangeAddress: Address;

    beforeEach(async () => {
      subjectWeth = setup.weth.address;
      subjectSteth = stEth.address;
      subjectExchangeAddress = stableswap.address;
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
      expect(await adapter.weth()).to.eq(subjectWeth);
    });

    it("should have the correct steth address", async () => {
      const adapter = await subject();
      expect(await adapter.stETH()).to.eq(subjectSteth);
    });

    it("should have the correct exchange address", async () => {
      const adapter = await subject();
      expect(await adapter.stableswap()).to.eq(subjectExchangeAddress);
    });

    it("should have approved the stableswap pool to spend stETH for correct amount", async () => {
      const adapter = await subject();
      expect(await stEth.allowance(adapter.address, stableswap.address)).to.eq(MAX_UINT_256);
    });

    context("when stableswap pool does not support ETH in index 0", async () => {
      beforeEach(async () => {
        const mock = await deployer.mocks.deployCurveStableswapMock([stEth.address, stEth.address]);
        subjectExchangeAddress = mock.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Stableswap pool has invalid ETH_INDEX");
      });
    });

    context("when stableswap pool does not support stETH in index 1", async () => {
      beforeEach(async () => {
        const mock = await deployer.mocks.deployCurveStableswapMock([ETH_ADDRESS, ETH_ADDRESS]);
        subjectExchangeAddress = mock.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Stableswap pool has invalid STETH_INDEX");
      });
    });
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

    async function subject(): Promise<[string, BigNumber, string]> {
      return await adapter.getTradeCalldata(
        subjectSourceToken,
        subjectDestinationToken,
        subjectMockSetToken,
        subjectSourceQuantity,
        subjectMinDestinationQuantity,
        EMPTY_BYTES,
      );
    }

    context("when buying stETH with eth", async () => {
      beforeEach(async () => {
        subjectSourceToken = ETH_ADDRESS;
        subjectSourceQuantity = BigNumber.from(100000000);
        subjectDestinationToken = stEth.address;
        subjectMinDestinationQuantity = ether(25);

        subjectMockSetToken = mockSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must swap between weth and stETH");
      });
    });

    context("when buying eth with stETH", async () => {
      beforeEach(async () => {
        subjectSourceToken = stEth.address;
        subjectSourceQuantity = BigNumber.from(100000000);
        subjectDestinationToken = ETH_ADDRESS;
        subjectMinDestinationQuantity = ether(25);

        subjectMockSetToken = mockSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must swap between weth and stETH");
      });
    });

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

        expect(calldata[0]).to.eq(adapter.address);
        expect(calldata[1]).to.eq(0);
        expect(calldata[2]).to.eq(expectedCallData);
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

        expect(calldata[0]).to.eq(adapter.address);
        expect(calldata[1]).to.eq(0);
        expect(calldata[2]).to.eq(expectedCallData);
      });
    });
  });

  describe("#buyStEth", async () => {
    let subjectSourceQuantity: BigNumber;
    let subjectMinDestinationQuantity: BigNumber;
    let subjectDestinationToken: Address;

    beforeEach(async () => {
      subjectSourceQuantity = ether(25);
      subjectMinDestinationQuantity = ether(25);
      subjectDestinationToken = mockSetToken.address;
    });

    async function subject(): Promise<ContractTransaction> {
      return await adapter
        .connect(owner.wallet)
        .buyStEth(subjectSourceQuantity, subjectMinDestinationQuantity, subjectDestinationToken);
    }

    it("should buy stEth", async () => {
      const previousStEthBalance = await stEth.balanceOf(subjectDestinationToken);
      const previousWethBalance = await setup.weth.balanceOf(owner.address);
      expect(previousStEthBalance).to.eq(0);
      expect(previousWethBalance).to.eq(ether(5000));

      await subject();

      const afterStEthBalance = await stEth.balanceOf(subjectDestinationToken);
      const afterWethBalance = await setup.weth.balanceOf(owner.address);
      expect(afterStEthBalance).to.eq(subjectMinDestinationQuantity);
      expect(afterWethBalance).to.eq(previousWethBalance.sub(subjectSourceQuantity));
    });
  });

  describe("#sellStEth", async () => {
    let subjectSourceQuantity: BigNumber;
    let subjectMinDestinationQuantity: BigNumber;
    let subjectDestinationToken: Address;

    beforeEach(async () => {
      subjectSourceQuantity = ether(25);
      subjectMinDestinationQuantity = ether(25);
      subjectDestinationToken = mockSetToken.address;
    });

    async function subject(): Promise<ContractTransaction> {
      return await adapter
        .connect(owner.wallet)
        .sellStEth(subjectSourceQuantity, subjectMinDestinationQuantity, subjectDestinationToken);
    }

    it("should sell stEth", async () => {
      const previousStEthBalance = await stEth.balanceOf(owner.address);
      const previousWethBalance = await setup.weth.balanceOf(subjectDestinationToken);
      expect(previousStEthBalance).to.eq(ether(1000000000));
      expect(previousWethBalance).to.eq(0);

      await subject();

      const afterStEthBalance = await stEth.balanceOf(owner.address);
      const afterWethBalance = await setup.weth.balanceOf(subjectDestinationToken);
      expect(afterStEthBalance).to.eq(previousStEthBalance.sub(subjectSourceQuantity));
      expect(afterWethBalance).to.eq(subjectMinDestinationQuantity);
    });
  });
});
