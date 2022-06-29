import "module-alias/register";

import { BigNumber, ethers } from "ethers";
import { utils } from "ethers";

import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import { ZERO } from "@utils/constants";
import { VelodromeExchangeAdapter } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getWaffleExpect,
  getLastBlockTimestamp,
} from "@utils/test/index";
import { SystemFixture } from "@utils/fixtures";
import { IVelodromeRouter__factory } from "@typechain/factories/IVelodromeRouter__factory";

const expect = getWaffleExpect();
describe("VelodromeExchangeAdapter", () => {
  const velodromRouterAddress = ethers.Wallet.createRandom().address;

  let owner: Account;
  let mockSetToken: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;
  let velodromeExchangeAdapter: VelodromeExchangeAdapter;

  before(async () => {
    [owner, mockSetToken] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    velodromeExchangeAdapter = await deployer.adapters.deployVelodromeExchangeAdapter(
      velodromRouterAddress,
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("constructor", async () => {
    let subjectVelodromeRouter: Address;

    beforeEach(async () => {
      subjectVelodromeRouter = velodromRouterAddress;
    });

    async function subject(): Promise<any> {
      return await deployer.adapters.deployVelodromeExchangeAdapter(subjectVelodromeRouter);
    }

    it("should have the correct router address", async () => {
      const deployedVelodromeV2ExchangeAdapter = await subject();

      const actualRouterAddress = await deployedVelodromeV2ExchangeAdapter.router();
      expect(actualRouterAddress).to.eq(velodromRouterAddress);
    });
  });

  describe("getSpender", async () => {
    async function subject(): Promise<any> {
      return await velodromeExchangeAdapter.getSpender();
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();

      expect(spender).to.eq(velodromRouterAddress);
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
      sourceAddress = setup.wbtc.address; // WBTC Address
      sourceQuantity = BigNumber.from(100000000); // Trade 1 WBTC
      destinationAddress = setup.dai.address; // DAI Address
      destinationQuantity = ether(30000); // Receive at least 30k DAI

      subjectSourceToken = sourceAddress;
      subjectDestinationToken = destinationAddress;
      subjectMockSetToken = mockSetToken.address;
      subjectSourceQuantity = sourceQuantity;
      subjectMinDestinationQuantity = destinationQuantity;
    });

    async function subject(): Promise<any> {
      return await velodromeExchangeAdapter.getTradeCalldata(
        subjectSourceToken,
        subjectDestinationToken,
        subjectMockSetToken,
        subjectSourceQuantity,
        subjectMinDestinationQuantity,
        subjectData,
      );
    }

    it("should return the correct trade calldata", async () => {
      subjectData = await velodromeExchangeAdapter.generateDataParam([
        {
          from: sourceAddress,
          to: destinationAddress,
          stable: false,
        },
      ]);
      const calldata = await subject();
      const callTimestamp = await getLastBlockTimestamp();
      const expectedCallData = IVelodromeRouter__factory.createInterface().encodeFunctionData(
        "swapExactTokensForTokens",
        [
          sourceQuantity,
          destinationQuantity,
          [{ from: sourceAddress, to: destinationAddress, stable: false }],
          subjectMockSetToken,
          callTimestamp,
        ],
      );
      expect(JSON.stringify(calldata)).to.eq(
        JSON.stringify([velodromRouterAddress, ZERO, expectedCallData]),
      );
    });

    describe("when passed in custom path to trade data", async () => {
      beforeEach(async () => {
        const path = [sourceAddress, setup.weth.address, destinationAddress];
        subjectData = utils.defaultAbiCoder.encode(["address[]"], [path]);
      });

      it("should return the correct trade calldata", async () => {
        subjectData = await velodromeExchangeAdapter.generateDataParam([
          { from: sourceAddress, to: setup.weth.address, stable: false },
          { from: setup.weth.address, to: destinationAddress, stable: false },
        ]);
        const calldata = await subject();
        const callTimestamp = await getLastBlockTimestamp();
        const expectedCallData = IVelodromeRouter__factory.createInterface().encodeFunctionData(
          "swapExactTokensForTokens",
          [
            sourceQuantity,
            destinationQuantity,
            [
              { from: sourceAddress, to: setup.weth.address, stable: false },
              { from: setup.weth.address, to: destinationAddress, stable: false },
            ],
            subjectMockSetToken,
            callTimestamp,
          ],
        );
        expect(JSON.stringify(calldata)).to.eq(
          JSON.stringify([velodromRouterAddress, ZERO, expectedCallData]),
        );
      });
    });
  });
});
