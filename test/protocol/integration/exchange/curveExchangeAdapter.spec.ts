import "module-alias/register";

import { BigNumber, ContractTransaction } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { EMPTY_BYTES, MAX_UINT_256 } from "@utils/constants";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getWaffleExpect,
} from "@utils/test/index";

import { SystemFixture } from "@utils/fixtures";
import { CurveExchangeAdapter, CurveStableswapMock } from "@utils/contracts";

import { StandardTokenMock } from "@typechain/StandardTokenMock";

const expect = getWaffleExpect();

describe("CurveExchangeAdapter", () => {
  let owner: Account;
  let whale: Account;
  let mockSetToken: Account;
  let stEth: StandardTokenMock;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let stableswap: CurveStableswapMock;
  let adapter: CurveExchangeAdapter;

  before(async () => {
    [owner, whale, mockSetToken] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    stEth = await deployer.mocks.deployTokenMock(owner.address);
    await setup.weth.connect(whale.wallet).deposit({ value: ether(100) });
    await stEth.connect(whale.wallet).mint(whale.address, ether(100));

    stableswap = await deployer.mocks.deployCurveStableswapMock([
      setup.weth.address,
      stEth.address,
    ]);

    adapter = await deployer.adapters.deployCurveExchangeAdapter(
      setup.weth.address,
      stEth.address,
      BigNumber.from(0),
      BigNumber.from(1),
      stableswap.address,
    );

    await stEth.connect(owner.wallet).approve(adapter.address, MAX_UINT_256);
    await setup.weth.connect(owner.wallet).approve(adapter.address, MAX_UINT_256);

    await stEth.connect(whale.wallet).approve(stableswap.address, MAX_UINT_256);
    await setup.weth.connect(whale.wallet).approve(stableswap.address, MAX_UINT_256);
    await stableswap.connect(whale.wallet).add_liquidity([ether(100), ether(100)], ether(1));
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectWeth: Address;
    let subjectSteth: Address;
    let subjectWethIndex: BigNumber;
    let subjectStethIndex: BigNumber;
    let subjectExchangeAddress: Address;

    beforeEach(async () => {
      subjectWeth = setup.weth.address;
      subjectSteth = stEth.address;
      subjectWethIndex = BigNumber.from(0);
      subjectStethIndex = BigNumber.from(1);
      subjectExchangeAddress = stableswap.address;
    });

    async function subject(): Promise<CurveExchangeAdapter> {
      return await deployer.adapters.deployCurveExchangeAdapter(
        subjectWeth,
        subjectSteth,
        subjectWethIndex,
        subjectStethIndex,
        subjectExchangeAddress,
      );
    }
    it("should have the correct weth address", async () => {
      const adapter = await subject();
      expect(await adapter.tokenA()).to.eq(subjectWeth);
    });

    it("should have the correct steth address", async () => {
      const adapter = await subject();
      expect(await adapter.tokenB()).to.eq(subjectSteth);
    });

    it("should have the correct weth index", async () => {
      const adapter = await subject();
      expect(await adapter.tokenAIndex()).to.eq(0);
    });

    it("should have the correct steth index", async () => {
      const adapter = await subject();
      expect(await adapter.tokenBIndex()).to.eq(1);
    });

    it("should have the correct exchange address", async () => {
      const adapter = await subject();
      expect(await adapter.stableswap()).to.eq(subjectExchangeAddress);
    });

    context("when incorrect tokenAIndex is passed in", async () => {
      beforeEach(async () => {
        subjectWeth = setup.weth.address;
        subjectSteth = stEth.address;
        subjectWethIndex = BigNumber.from(1);
        subjectStethIndex = BigNumber.from(1);
        subjectExchangeAddress = stableswap.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Stableswap pool has invalid index for tokenA");
      });
    });

    context("when incorrect tokenBIndex is passed in", async () => {
      beforeEach(async () => {
        subjectWeth = setup.weth.address;
        subjectSteth = stEth.address;
        subjectWethIndex = BigNumber.from(0);
        subjectStethIndex = BigNumber.from(0);
        subjectExchangeAddress = stableswap.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Stableswap pool has invalid index for tokenB");
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

    context("when buying stETH with weth", async () => {
      beforeEach(async () => {
        subjectSourceToken = setup.weth.address;
        subjectSourceQuantity = BigNumber.from(100000000);
        subjectDestinationToken = stEth.address;
        subjectMinDestinationQuantity = ether(25);

        subjectMockSetToken = mockSetToken.address;
      });

      it("should return calldata", async () => {
        const expectedCalldata = await adapter.interface.encodeFunctionData("trade", [
          subjectSourceToken,
          subjectDestinationToken,
          subjectSourceQuantity,
          subjectMinDestinationQuantity,
          subjectMockSetToken,
        ]);
        const callData = await subject();
        expect(callData[0]).to.eq(adapter.address);
        expect(callData[1]).to.eq(0);
        expect(JSON.stringify(callData[2])).to.eq(JSON.stringify(expectedCalldata));
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

      it("should return calldata", async () => {
        const expectedCalldata = await adapter.interface.encodeFunctionData("trade", [
          subjectSourceToken,
          subjectDestinationToken,
          subjectSourceQuantity,
          subjectMinDestinationQuantity,
          subjectMockSetToken,
        ]);
        const callData = await subject();
        expect(callData[0]).to.eq(adapter.address);
        expect(callData[1]).to.eq(0);
        expect(JSON.stringify(callData[2])).to.eq(JSON.stringify(expectedCalldata));
      });
    });

    context("when sourceToken and destinationToken are the same", async () => {
      beforeEach(async () => {
        subjectSourceToken = stEth.address;
        subjectSourceQuantity = BigNumber.from(100000000);
        subjectDestinationToken = stEth.address;
        subjectMinDestinationQuantity = ether(25);

        subjectMockSetToken = mockSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith(
          "_sourceToken must not be the same as _destinationToken",
        );
      });
    });

    context("when an invalid sourceToken is passed in", async () => {
      beforeEach(async () => {
        subjectSourceToken = setup.dai.address;
        subjectSourceQuantity = BigNumber.from(100000000);
        subjectDestinationToken = setup.weth.address;
        subjectMinDestinationQuantity = ether(25);

        subjectMockSetToken = mockSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid sourceToken");
      });
    });

    context("when an invalid destinationToken is passed in", async () => {
      beforeEach(async () => {
        subjectSourceToken = stEth.address;
        subjectSourceQuantity = BigNumber.from(100000000);
        subjectDestinationToken = setup.dai.address;
        subjectMinDestinationQuantity = ether(25);

        subjectMockSetToken = mockSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid destinationToken");
      });
    });
  });

  describe("#trade", async () => {
    let subjectMockSetToken: Address;
    let subjectSourceToken: Address;
    let subjectDestinationToken: Address;
    let subjectSourceQuantity: BigNumber;
    let subjectMinDestinationQuantity: BigNumber;

    async function subject(): Promise<ContractTransaction> {
      return await adapter
        .connect(owner.wallet)
        .trade(
          subjectSourceToken,
          subjectDestinationToken,
          subjectSourceQuantity,
          subjectMinDestinationQuantity,
          subjectMockSetToken,
        );
    }

    context("when trading steth for weth", async () => {
      beforeEach(async () => {
        subjectSourceToken = stEth.address;
        subjectSourceQuantity = ether(25);
        subjectDestinationToken = setup.weth.address;
        subjectMinDestinationQuantity = ether(25);

        subjectMockSetToken = mockSetToken.address;
      });

      it("should succeed", async () => {
        const previousStEthBalance = await stEth.balanceOf(owner.address);
        const previousWethBalance = await setup.weth.balanceOf(subjectMockSetToken);
        expect(previousStEthBalance).to.eq(ether(1000000000));
        expect(previousWethBalance).to.eq(0);

        await subject();

        const afterStEthBalance = await stEth.balanceOf(owner.address);
        const afterWethBalance = await setup.weth.balanceOf(subjectMockSetToken);
        expect(afterStEthBalance).to.eq(previousStEthBalance.sub(subjectSourceQuantity));
        expect(afterWethBalance).to.eq(previousWethBalance.add(subjectMinDestinationQuantity));
      });
    });

    context("when trading weth for steth", async () => {
      beforeEach(async () => {
        subjectSourceToken = setup.weth.address;
        subjectSourceQuantity = ether(25);
        subjectDestinationToken = stEth.address;
        subjectMinDestinationQuantity = ether(25);

        subjectMockSetToken = mockSetToken.address;
      });

      it("should succeed", async () => {
        const previousWethBalance = await setup.weth.balanceOf(owner.address);
        const previousStEthBalance = await stEth.balanceOf(subjectMockSetToken);
        expect(previousWethBalance).to.eq(ether(5000));
        expect(previousStEthBalance).to.eq(0);

        await subject();

        const afterWethBalance = await setup.weth.balanceOf(owner.address);
        const afterStEthBalance = await stEth.balanceOf(subjectMockSetToken);
        expect(afterWethBalance).to.eq(previousWethBalance.sub(subjectSourceQuantity));
        expect(afterStEthBalance).to.eq(previousStEthBalance.add(subjectMinDestinationQuantity));
      });
    });

    context("when sourceToken and destinationToken are the same", async () => {
      beforeEach(async () => {
        subjectSourceToken = stEth.address;
        subjectSourceQuantity = ether(25);
        subjectDestinationToken = stEth.address;
        subjectMinDestinationQuantity = ether(25);

        subjectMockSetToken = mockSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith(
          "_sourceToken must not be the same as _destinationToken",
        );
      });
    });

    context("when an invalid sourceToken is passed in", async () => {
      beforeEach(async () => {
        subjectSourceToken = setup.dai.address;
        subjectSourceQuantity = BigNumber.from(100000000);
        subjectDestinationToken = setup.weth.address;
        subjectMinDestinationQuantity = ether(25);

        subjectMockSetToken = mockSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith(
          "Invalid _sourceToken or _destinationToken or both",
        );
      });
    });

    context("when an invalid destinationToken is passed in", async () => {
      beforeEach(async () => {
        subjectSourceToken = stEth.address;
        subjectSourceQuantity = BigNumber.from(100000000);
        subjectDestinationToken = setup.dai.address;
        subjectMinDestinationQuantity = ether(25);

        subjectMockSetToken = mockSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith(
          "Invalid _sourceToken or _destinationToken or both",
        );
      });
    });
  });
});
