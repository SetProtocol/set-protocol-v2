import "module-alias/register";

import { BigNumber } from "ethers";

import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  EMPTY_BYTES,
  THREE,
  ZERO,
} from "@utils/constants";
import { BalancerV1IndexExchangeAdapter } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
} from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getBalancerFixture,
  getWaffleExpect
} from "@utils/test/index";

import { SystemFixture, BalancerFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("BalancerV1IndexExchangeAdapter", () => {
  let owner: Account;
  let mockSetToken: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;
  let balancerSetup: BalancerFixture;

  let balancerV1ExchangeAdapter: BalancerV1IndexExchangeAdapter;

  before(async () => {
    [
      owner,
      mockSetToken,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    balancerSetup = getBalancerFixture(owner.address);
    await balancerSetup.initialize(
      owner,
      setup.weth,
      setup.wbtc,
      setup.dai
    );

    balancerV1ExchangeAdapter = await deployer.adapters.deployBalancerV1IndexExchangeAdapter(balancerSetup.exchange.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("constructor", async () => {
    let subjectBalancerProxyAddress: Address;

    beforeEach(async () => {
      subjectBalancerProxyAddress = balancerSetup.exchange.address;
    });

    async function subject(): Promise<any> {
      return await deployer.adapters.deployBalancerV1IndexExchangeAdapter(subjectBalancerProxyAddress);
    }

    it("should have the correct proxy address", async () => {
      const deployedBalancerV1ExchangeAdapter = await subject();

      const actualProxyAddress = await deployedBalancerV1ExchangeAdapter.balancerProxy();
      expect(actualProxyAddress).to.eq(subjectBalancerProxyAddress);
    });
  });

  describe("getSpender", async () => {
    async function subject(): Promise<any> {
      return await balancerV1ExchangeAdapter.getSpender();
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();

      expect(spender).to.eq(balancerSetup.exchange.address);
    });
  });

  describe("getTradeCalldata", async () => {
    let sourceToken: Address;
    let destinationToken: Address;
    let sourceQuantity: BigNumber;
    let destinationQuantity: BigNumber;

    let subjectMockSetToken: Address;
    let subjectSourceToken: Address;
    let subjectDestinationToken: Address;
    let subjectIsSendTokenFixed: boolean;
    let subjectSourceQuantity: BigNumber;
    let subjectMinDestinationQuantity: BigNumber;
    let subjectData: Bytes;

    beforeEach(async () => {
      sourceToken = setup.wbtc.address;          		// WBTC Address
      sourceQuantity = BigNumber.from(100000000);  	// Trade 1 WBTC
      destinationToken = setup.dai.address;      		// DAI Address
      destinationQuantity = ether(30000);          	// Receive at least 30k DAI

      subjectSourceToken = sourceToken;
      subjectDestinationToken = destinationToken;
      subjectMockSetToken = mockSetToken.address;
      subjectIsSendTokenFixed = true;
      subjectSourceQuantity = sourceQuantity;
      subjectMinDestinationQuantity = destinationQuantity;
      subjectData = EMPTY_BYTES;
    });

    async function subject(): Promise<any> {
      return await balancerV1ExchangeAdapter.getTradeCalldata(
        subjectSourceToken,
        subjectDestinationToken,
        subjectMockSetToken,
        subjectIsSendTokenFixed,
        subjectSourceQuantity,
        subjectMinDestinationQuantity,
        subjectData,
      );
    }

    describe("when boolean fixed input amount is true", async () => {
      it("should return the correct trade calldata", async () => {
        const calldata = await subject();

        const expectedCallData = balancerSetup.exchange.interface.encodeFunctionData("smartSwapExactIn", [
          sourceToken,
          destinationToken,
          sourceQuantity,
          destinationQuantity,
          THREE,
        ]);
        expect(JSON.stringify(calldata)).to.eq(JSON.stringify([balancerSetup.exchange.address, ZERO, expectedCallData]));
      });
    });

    describe("when boolean fixed input amount is false", async () => {
      beforeEach(async () => {
        subjectIsSendTokenFixed = false;
      });

      it("should return the correct trade calldata", async () => {
        const calldata = await subject();

        const expectedCallData = balancerSetup.exchange.interface.encodeFunctionData("smartSwapExactOut", [
          sourceToken,
          destinationToken,
          destinationQuantity, // Source and destination quantity are flipped for smartSwapExactOut
          sourceQuantity,
          THREE,
        ]);
        expect(JSON.stringify(calldata)).to.eq(JSON.stringify([balancerSetup.exchange.address, ZERO, expectedCallData]));
      });
    });
  });
});
