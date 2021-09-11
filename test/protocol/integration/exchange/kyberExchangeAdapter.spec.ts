import "module-alias/register";

import { ethers } from "hardhat";
import { BigNumber } from "ethers";

import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  ADDRESS_ZERO,
  EMPTY_BYTES,
  ZERO,
} from "@utils/constants";
import { KyberExchangeAdapter, KyberNetworkProxyMock } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
} from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getWaffleExpect,
} from "@utils/test/index";

import { SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();


describe("KyberExchangeAdapter", () => {
  let owner: Account;
  let mockSetToken: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let kyberNetworkProxy: KyberNetworkProxyMock;
  let wbtcRate: BigNumber;
  let kyberExchangeAdapter: KyberExchangeAdapter;

  before(async () => {
    [
      owner,
      mockSetToken,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    wbtcRate = ether(33); // 1 WBTC = 33 ETH

    // Mock Kyber reserve only allows trading from/to WETH
    kyberNetworkProxy = await deployer.mocks.deployKyberNetworkProxyMock(setup.weth.address);
    await kyberNetworkProxy.addToken(
      setup.wbtc.address,
      wbtcRate,
      8
    );

    kyberExchangeAdapter = await deployer.adapters.deployKyberExchangeAdapter(kyberNetworkProxy.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("constructor", async () => {
    let subjectKyberNetworkProxy: Address;

    beforeEach(async () => {
      subjectKyberNetworkProxy = kyberNetworkProxy.address;
    });

    async function subject(): Promise<any> {
      return await deployer.adapters.deployKyberExchangeAdapter(subjectKyberNetworkProxy);
    }

    it("should have the correct Kyber proxy address", async () => {
      const deployedKyberExchangeAdapter = await subject();

      const actualKyberAddress = await deployedKyberExchangeAdapter.kyberNetworkProxyAddress();
      expect(actualKyberAddress).to.eq(kyberNetworkProxy.address);
    });
  });

  describe("getConversionRates", async () => {
    let subjectSourceToken: Address;
    let subjectDestinationToken: Address;
    let subjectSourceQuantity: BigNumber;

    beforeEach(async () => {
      subjectSourceToken = setup.wbtc.address;
      subjectDestinationToken = setup.weth.address;
      subjectSourceQuantity = ether(1);
    });

    async function subject(): Promise<any> {
      return await kyberExchangeAdapter.getConversionRates(
        subjectSourceToken,
        subjectDestinationToken,
        subjectSourceQuantity
      );
    }

    it("should return the correct exchange rate", async () => {
      const actualRates = await subject();

      expect(JSON.stringify(actualRates)).to.eq(JSON.stringify([wbtcRate, wbtcRate]));
    });
  });

  describe("getSpender", async () => {
    async function subject(): Promise<any> {
      return await kyberExchangeAdapter.getSpender();
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();

      expect(spender).to.eq(kyberNetworkProxy.address);
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
      sourceQuantity = BigNumber.from(100000000);   // Trade 1 WBTC
      destinationAddress = setup.weth.address;     // WETH Address
      destinationQuantity = ether(33);             // Receive at least 33 ETH

      subjectSourceToken = sourceAddress;
      subjectDestinationToken = destinationAddress;
      subjectMockSetToken = mockSetToken.address;
      subjectSourceQuantity = sourceQuantity;
      subjectMinDestinationQuantity = destinationQuantity;
      subjectData = EMPTY_BYTES;
    });

    async function subject(): Promise<any> {
      return await kyberExchangeAdapter.getTradeCalldata(
        subjectSourceToken,
        subjectDestinationToken,
        subjectMockSetToken,
        subjectSourceQuantity,
        subjectMinDestinationQuantity,
        subjectData,
      );
    }

    it("should return the correct trade calldata", async () => {
      const calldata = await subject();
      const expectedCallData = kyberNetworkProxy.interface.encodeFunctionData("trade", [
        sourceAddress,
        sourceQuantity,
        destinationAddress,
        mockSetToken.address,
        ethers.constants.MaxUint256,
        wbtcRate,
        ADDRESS_ZERO,
      ]);
      expect(JSON.stringify(calldata)).to.eq(JSON.stringify([kyberNetworkProxy.address, ZERO, expectedCallData]));
    });
  });
});
