import "module-alias/register";

import { BigNumber } from "@ethersproject/bignumber";

import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  EMPTY_BYTES,
  MAX_UINT_256,
} from "@utils/constants";
import { BalancerV2IndexExchangeAdapter } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
} from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getBalancerV2Fixture,
  getWaffleExpect
} from "@utils/test/index";

import { SystemFixture, BalancerV2Fixture } from "@utils/fixtures";
import { defaultAbiCoder } from "@ethersproject/abi";

const expect = getWaffleExpect();

describe("BalancerV2IndexExchangeAdapter", () => {
  let owner: Account;
  let mockSetToken: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;
  let balancerSetup: BalancerV2Fixture;

  let balancerV2ExchangeAdapter: BalancerV2IndexExchangeAdapter;

  before(async () => {
    [
      owner,
      mockSetToken,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    balancerSetup = getBalancerV2Fixture(owner.address);
    await balancerSetup.initialize(
      owner,
      setup.weth,
      setup.dai
    );

    balancerV2ExchangeAdapter = await deployer.adapters.deployBalancerV2IndexExchangeAdapter(balancerSetup.vault.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectVaultAddress: Address;

    beforeEach(async () => {
        subjectVaultAddress = balancerSetup.vault.address;
    });

    async function subject(): Promise<BalancerV2IndexExchangeAdapter> {
      return await deployer.adapters.deployBalancerV2IndexExchangeAdapter(subjectVaultAddress);
    }

    it("should have the correct vault address", async () => {
      const deployedBalancerV2ExchangeAdapter = await subject();

      const actualVaultAddress = await deployedBalancerV2ExchangeAdapter.vault();
      expect(actualVaultAddress).to.eq(subjectVaultAddress);
    });
  });

  describe("#getSpender", async () => {
    async function subject(): Promise<any> {
      return await balancerV2ExchangeAdapter.getSpender();
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();

      expect(spender).to.eq(balancerSetup.vault.address);
    });
  });

  describe("#getTradeCalldata", async () => {
    let sourceToken: Address;
    let destinationToken: Address;
    let sourceQuantity: BigNumber;
    let destinationQuantity: BigNumber;

    let subjectMockSetToken: Address;
    let subjectSourceToken: Address;
    let subjectDestinationToken: Address;
    let subjectIsSendTokenFixed: boolean;
    let subjectSourceQuantity: BigNumber;
    let subjectDestinationQuantity: BigNumber;
    let subjectData: Bytes;

    beforeEach(async () => {
      sourceToken = setup.weth.address;          		// WETH Address
      sourceQuantity = ether(1);  	                  // Trade 1 WETH
      destinationToken = setup.dai.address;      		// DAI Address
      destinationQuantity = ether(5000);          	// Receive at least 5k DAI

      subjectSourceToken = sourceToken;
      subjectDestinationToken = destinationToken;
      subjectMockSetToken = mockSetToken.address;
      subjectIsSendTokenFixed = true;
      subjectSourceQuantity = sourceQuantity;
      subjectDestinationQuantity = destinationQuantity;
      subjectData = defaultAbiCoder.encode(["bytes32"], [balancerSetup.wethDaiPoolId]);
    });

    async function subject(): Promise<[Address, BigNumber, string]> {
      return await balancerV2ExchangeAdapter.connect(mockSetToken.wallet).getTradeCalldata(
        subjectSourceToken,
        subjectDestinationToken,
        subjectMockSetToken,
        subjectIsSendTokenFixed,
        subjectSourceQuantity,
        subjectDestinationQuantity,
        subjectData,
      );
    }

    context("when boolean fixed input amount is true", async () => {
      it("should return the correct trade calldata", async () => {
        const [ to, value, calldata ] = await subject();

        const expectedCalldata = balancerSetup.vault.interface.encodeFunctionData("swap", [
          {
            poolId: balancerSetup.wethDaiPoolId,
            kind: 0,
            assetIn: subjectSourceToken,
            assetOut: subjectDestinationToken,
            amount: subjectSourceQuantity,
            userData: EMPTY_BYTES,
          },
          {
            sender: mockSetToken.address,
            fromInternalBalance: false,
            recipient: mockSetToken.address,
            toInternalBalance: false,
          },
          subjectDestinationQuantity,
          MAX_UINT_256,
        ]);

        expect(to).to.eq(balancerSetup.vault.address);
        expect(value).to.eq(0);
        expect(calldata).to.eq(expectedCalldata);
      });
    });

    context("when boolean fixed input amount is false", async () => {
      beforeEach(async () => {
        subjectIsSendTokenFixed = false;
      });

      it("should return the correct trade calldata", async () => {
        const [ to, value, calldata ] = await subject();

        const expectedCalldata = balancerSetup.vault.interface.encodeFunctionData("swap", [
          {
            poolId: balancerSetup.wethDaiPoolId,
            kind: 1,
            assetIn: subjectSourceToken,
            assetOut: subjectDestinationToken,
            amount: subjectDestinationQuantity,
            userData: EMPTY_BYTES,
          },
          {
            sender: mockSetToken.address,
            fromInternalBalance: false,
            recipient: mockSetToken.address,
            toInternalBalance: false,
          },
          subjectSourceQuantity,
          MAX_UINT_256,
        ]);

        expect(to).to.eq(balancerSetup.vault.address);
        expect(value).to.eq(0);
        expect(calldata).to.eq(expectedCalldata);
      });
    });
  });
});
