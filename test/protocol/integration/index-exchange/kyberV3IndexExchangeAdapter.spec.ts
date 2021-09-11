import "module-alias/register";

import { BigNumber } from "ethers";

import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { KyberV3IndexExchangeAdapter } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
} from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getKyberV3DMMFixture,
  getWaffleExpect,
  getLastBlockTimestamp,
  getRandomAddress
} from "@utils/test/index";

import { SystemFixture, KyberV3DMMFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("KyberV3IndexExchangeAdapter", () => {
  let owner: Account;
  let mockSetToken: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;
  let kyberSetup: KyberV3DMMFixture;

  let kyberV3ExchangeAdapter: KyberV3IndexExchangeAdapter;

  before(async () => {
    [
      owner,
      mockSetToken,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    kyberSetup = getKyberV3DMMFixture(owner.address);
    await kyberSetup.initialize(owner, setup.weth.address, setup.wbtc.address, setup.dai.address);

    kyberV3ExchangeAdapter = await deployer.adapters.deployKyberV3IndexExchangeAdapter(
      kyberSetup.dmmRouter.address,
      kyberSetup.dmmFactory.address
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("constructor", async () => {
    let subjectDMMRouter: Address;
    let subjectDMMFactory: Address;

    beforeEach(async () => {
      subjectDMMRouter = kyberSetup.dmmRouter.address;
      subjectDMMFactory = kyberSetup.dmmFactory.address;
    });

    async function subject(): Promise<any> {
      return await deployer.adapters.deployKyberV3IndexExchangeAdapter(subjectDMMRouter, subjectDMMFactory);
    }

    it("should have the correct router address", async () => {
      const deployedKyberV3IndexExchangeAdapter = await subject();

      const routerAddress = await deployedKyberV3IndexExchangeAdapter.dmmRouter();
      const expectedRouterAddress = kyberSetup.dmmRouter.address;

      expect(routerAddress).to.eq(expectedRouterAddress);
    });

    it("should have the correct factory address", async () => {
      const deployedKyberV3IndexExchangeAdapter = await subject();

      const factoryAddress = await deployedKyberV3IndexExchangeAdapter.dmmFactory();
      const expectedFactoryAddress = kyberSetup.dmmFactory.address;

      expect(factoryAddress).to.eq(expectedFactoryAddress);
    });
  });

  describe("getSpender", async () => {
    async function subject(): Promise<any> {
      return await kyberV3ExchangeAdapter.getSpender();
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();
      const expectedSpender = kyberSetup.dmmRouter.address;

      expect(spender).to.eq(expectedSpender);
    });
  });

  describe("getTradeCalldata", async () => {
    let sourceToken: Address;
    let destinationToken: Address;
    let sourceQuantity: BigNumber;
    let destinationQuantity: BigNumber;
    let poolAddress: Address;

    let subjectMockSetToken: Address;
    let subjectSourceToken: Address;
    let subjectDestinationToken: Address;
    let subjectIsSendTokenFixed: boolean;
    let subjectSourceQuantity: BigNumber;
    let subjectDestinationQuantity: BigNumber;
    let subjectData: Bytes;

    beforeEach(async () => {
      sourceToken = kyberSetup.knc.address;       // KNC Address
      sourceQuantity = ether(100);                // Trade 100 KNC
      destinationToken = setup.weth.address;      // WETH Address
      destinationQuantity = ether(10);            // Receive at least 10 ETH
      poolAddress = (kyberSetup.kncWethPool.address).toLowerCase();

      subjectSourceToken = sourceToken;
      subjectDestinationToken = destinationToken;
      subjectMockSetToken = mockSetToken.address;
      subjectIsSendTokenFixed = true;
      subjectSourceQuantity = sourceQuantity;
      subjectDestinationQuantity = destinationQuantity;
      subjectData = poolAddress;
    });

    async function subject(): Promise<any> {
      return await kyberV3ExchangeAdapter.getTradeCalldata(
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
        const calldata = await subject();
        const callTimestamp = await getLastBlockTimestamp();
        const expectedCallData = kyberSetup.dmmRouter.interface.encodeFunctionData("swapExactTokensForTokens", [
          sourceQuantity,
          destinationQuantity,
          [poolAddress],
          [sourceToken, destinationToken],
          subjectMockSetToken,
          callTimestamp,
        ]);
        expect(JSON.stringify(calldata)).to.eq(JSON.stringify([kyberSetup.dmmRouter.address, ZERO, expectedCallData]));
      });
    });

    describe("when boolean to swap exact tokens for tokens is false", async () => {
      beforeEach(async () => {
        subjectIsSendTokenFixed = false;
      });

      it("should return the correct trade calldata", async () => {
        const calldata = await subject();
        const callTimestamp = await getLastBlockTimestamp();
        const expectedCallData = kyberSetup.dmmRouter.interface.encodeFunctionData("swapTokensForExactTokens", [
          destinationQuantity, // Source and destination quantity are flipped for swapTokensForExactTokens
          sourceQuantity,
          [poolAddress],
          [sourceToken, destinationToken],
          subjectMockSetToken,
          callTimestamp,
        ]);
        expect(JSON.stringify(calldata)).to.eq(JSON.stringify([kyberSetup.dmmRouter.address, ZERO, expectedCallData]));
      });
    });

    describe("when pool address is invalid", async () => {
      describe("when pool address is zero address", async () => {
        beforeEach(async () => {
          subjectData = ADDRESS_ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Invalid pool address");
        });
      });

      describe("when pool address is random address", async () => {
        beforeEach(async () => {
          subjectData = (await getRandomAddress()).toLowerCase();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Invalid pool address");
        });
      });

      describe("when pool address is for another token pair", async () => {
        beforeEach(async () => {
          subjectData = kyberSetup.wethDaiPool.address.toLowerCase();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Invalid pool address");
        });
      });
    });
  });
});
