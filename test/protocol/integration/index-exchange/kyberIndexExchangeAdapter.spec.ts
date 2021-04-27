import "module-alias/register";

import { ethers } from "hardhat";
import { BigNumber } from "@ethersproject/bignumber";

import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  ADDRESS_ZERO,
  EMPTY_BYTES,
  ZERO,
} from "@utils/constants";
import { KyberIndexExchangeAdapter, KyberNetworkProxyMock } from "@utils/contracts";
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


describe("KyberIndexExchangeAdapter", () => {
  let owner: Account;
  let mockSetToken: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let kyberNetworkProxy: KyberNetworkProxyMock;
  let wbtcRate: BigNumber;
  let kyberIndexExchangeAdapter: KyberIndexExchangeAdapter;

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

    kyberIndexExchangeAdapter = await deployer.adapters.deployKyberIndexExchangeAdapter(kyberNetworkProxy.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("constructor", async () => {
    let subjectKyberNetworkProxy: Address;

    beforeEach(async () => {
      subjectKyberNetworkProxy = kyberNetworkProxy.address;
    });

    async function subject(): Promise<any> {
      return await deployer.adapters.deployKyberIndexExchangeAdapter(subjectKyberNetworkProxy);
    }

    it("should have the correct Kyber proxy address", async () => {
      const deployedKyberIndexExchangeAdapter = await subject();

      const actualKyberAddress = await deployedKyberIndexExchangeAdapter.kyberNetworkProxyAddress();
      expect(actualKyberAddress).to.eq(kyberNetworkProxy.address);
    });
  });


  describe("getSpender", async () => {
    async function subject(): Promise<any> {
      return await kyberIndexExchangeAdapter.getSpender();
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
    let subjectDestinationQuantity: BigNumber;
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
      subjectDestinationQuantity = destinationQuantity;
      subjectData = EMPTY_BYTES;
    });

    async function subject(): Promise<any> {
      return await kyberIndexExchangeAdapter.getTradeCalldata(
        subjectSourceToken,
        subjectDestinationToken,
        subjectMockSetToken,
        true,
        subjectSourceQuantity,
        subjectDestinationQuantity,
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
