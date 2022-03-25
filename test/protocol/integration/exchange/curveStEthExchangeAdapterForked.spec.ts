import "module-alias/register";

import { BigNumber, ContractTransaction } from "ethers";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { MAX_UINT_256 } from "@utils/constants";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getForkedTokens,
  getSystemFixture,
  getWaffleExpect,
  initializeForkedTokens
} from "@utils/test/index";

import { SystemFixture } from "@utils/fixtures";
import { CurveStEthExchangeAdapter, CurveEthStEthExchangeMock } from "@utils/contracts";

import { StandardTokenMock } from "@typechain/StandardTokenMock";
import dependencies from "@utils/deploys/dependencies";

const expect = getWaffleExpect();

describe("CurveStEthExchangeAdapter [ @forked-mainnet ]", () => {
  let owner: Account;
  let whale: Account;
  let mockSetToken: Account;
  let weth: StandardTokenMock;
  let stEth: StandardTokenMock;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let exchange: CurveEthStEthExchangeMock;
  let adapter: CurveStEthExchangeAdapter;

  before(async () => {
    [owner, whale, mockSetToken] = await getAccounts();


    deployer = new DeployHelper(owner.wallet);
    await initializeForkedTokens(deployer);

    setup = getSystemFixture(owner.address);
    await setup.initialize();

    weth = await deployer.mocks.getTokenMock(dependencies.WETH[1]);
    stEth = await deployer.mocks.getTokenMock(dependencies.STETH[1]);
    exchange = await deployer.mocks.getForkedCurveEthStEthExchange();

    adapter = await deployer.adapters.deployCurveStEthExchangeAdapter(
      weth.address,
      stEth.address,
      exchange.address
    );

    await stEth.connect(owner.wallet).approve(adapter.address, MAX_UINT_256);
    await weth.connect(owner.wallet).approve(adapter.address, MAX_UINT_256);

    const tokens = getForkedTokens();
    // Fund the whale with WETH from whale
    await tokens.weth.transfer(whale.address, ether(500));
    await weth.connect(whale.wallet).approve(adapter.address, MAX_UINT_256);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#buyStEth", async () => {
    let subjectSourceQuantity: BigNumber;
    let subjectMinDestinationQuantity: BigNumber;
    let subjectDestinationToken: Address;

    beforeEach(async () => {
      subjectSourceQuantity = ether(25);
      subjectMinDestinationQuantity = ether(25);
      subjectDestinationToken = mockSetToken.address;

      await weth.connect(whale.wallet).transfer(owner.address, ether(25));
    });

    async function subject(): Promise<ContractTransaction> {
      return await adapter
        .connect(owner.wallet)
        .buyStEth(subjectSourceQuantity, subjectMinDestinationQuantity, subjectDestinationToken);
    }

    it("should buy stEth", async () => {
      const previousStEthBalance = await stEth.balanceOf(subjectDestinationToken);
      const previousWethBalance = await weth.balanceOf(owner.address);
      expect(previousStEthBalance).to.eq(0);
      expect(previousWethBalance).to.eq(ether(25));

      await subject();

      const afterStEthBalance = await stEth.balanceOf(subjectDestinationToken);
      const afterWethBalance = await weth.balanceOf(owner.address);
      expect(afterStEthBalance).to.be.gte(subjectMinDestinationQuantity.add(previousStEthBalance));
      expect(afterWethBalance).to.eq(previousWethBalance.sub(subjectSourceQuantity));
    });
  });

  describe("#sellStEth", async () => {
    let subjectSourceQuantity: BigNumber;
    let subjectMinDestinationQuantity: BigNumber;
    let subjectDestinationToken: Address;

    beforeEach(async () => {
      subjectSourceQuantity = ether(25);
      subjectMinDestinationQuantity = ether(24);
      subjectDestinationToken = mockSetToken.address;

      // Whale to purchase stETH
      await adapter.connect(whale.wallet).buyStEth(ether(100), ether(100), whale.address);
      // Whale to transfer stETH to owner
      await stEth.connect(whale.wallet).transfer(owner.address, ether(100));
    });

    async function subject(): Promise<ContractTransaction> {
      return await adapter
        .connect(owner.wallet)
        .sellStEth(subjectSourceQuantity, subjectMinDestinationQuantity, subjectDestinationToken);
    }

    it("should sell stEth", async () => {
      const previousStEthBalance = await stEth.balanceOf(owner.address);
      const previousWethBalance = await weth.balanceOf(subjectDestinationToken);
      expect(previousStEthBalance).to.be.closeTo(ether(100), 1);
      expect(previousWethBalance).to.eq(0);

      await subject();

      const afterStEthBalance = await stEth.balanceOf(owner.address);
      const afterWethBalance = await weth.balanceOf(subjectDestinationToken);
      expect(afterStEthBalance).to.be.closeTo(previousStEthBalance.sub(subjectSourceQuantity), 1);
      expect(afterWethBalance).to.gte(subjectMinDestinationQuantity.add(previousWethBalance));
    });
  });
});
