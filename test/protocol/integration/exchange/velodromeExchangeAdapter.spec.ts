import "module-alias/register";

import { BigNumber } from "ethers";
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
  getVelodromeFixture,
} from "@utils/test/index";
import { SystemFixture } from "@utils/fixtures";
import { VelodromeFixture } from "@utils/fixtures/velodromeFixture";
import { ethers } from "hardhat";

const expect = getWaffleExpect();
describe("VelodromeExchangeAdapter", () => {
  let owner: Account;
  let mockSetToken: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;
  let velodromeSetup: VelodromeFixture;
  let velodromeExchangeAdapter: VelodromeExchangeAdapter;

  before(async () => {
    [owner, mockSetToken] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    velodromeSetup = getVelodromeFixture(owner.address);
    await velodromeSetup.initialize(owner, setup.weth.address);

    velodromeExchangeAdapter = await deployer.adapters.deployVelodromeExchangeAdapter(
      velodromeSetup.router.address,
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("constructor", async () => {
    let subjectVelodromeRouter: Address;

    beforeEach(async () => {
      subjectVelodromeRouter = velodromeSetup.router.address;
    });

    async function subject(): Promise<any> {
      return await deployer.adapters.deployVelodromeExchangeAdapter(subjectVelodromeRouter);
    }

    it("should have the correct router address", async () => {
      const deployedVelodromeV2ExchangeAdapter = await subject();

      const actualRouterAddress = await deployedVelodromeV2ExchangeAdapter.router();
      expect(actualRouterAddress).to.eq(velodromeSetup.router.address);
    });
  });

  describe("getSpender", async () => {
    async function subject(): Promise<any> {
      return await velodromeExchangeAdapter.getSpender();
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();

      expect(spender).to.eq(velodromeSetup.router.address);
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

    describe("wbtc -> dai", async () => {
      it("should return the correct data param", async () => {
        subjectData = await velodromeExchangeAdapter.generateDataParam(
          [
            {
              from: sourceAddress,
              to: destinationAddress,
              stable: false,
            },
          ],
          ethers.constants.MaxUint256,
        );
        expect(subjectData).to.eq(
          ethers.utils.defaultAbiCoder.encode(
            ["tuple(address,address,bool)[]", "uint256"],
            [[[sourceAddress, destinationAddress, false]], ethers.constants.MaxUint256],
          ),
        );
      });

      it("should return the correct trade calldata", async () => {
        const callTimestamp = await getLastBlockTimestamp();
        subjectData = await velodromeExchangeAdapter.generateDataParam(
          [
            {
              from: sourceAddress,
              to: destinationAddress,
              stable: false,
            },
          ],
          callTimestamp,
        );
        const calldata = await subject();
        const expectedCallData = velodromeSetup.router.interface.encodeFunctionData(
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
          JSON.stringify([velodromeSetup.router.address, ZERO, expectedCallData]),
        );
      });
    });

    describe("wbtc -> weth -> dai", async () => {
      beforeEach(async () => {
        const path = [sourceAddress, setup.weth.address, destinationAddress];
        subjectData = utils.defaultAbiCoder.encode(["address[]"], [path]);
      });

      it("should return the correct data param", async () => {
        subjectData = await velodromeExchangeAdapter.generateDataParam(
          [
            { from: sourceAddress, to: setup.weth.address, stable: false },
            { from: setup.weth.address, to: destinationAddress, stable: false },
          ],
          ethers.constants.MaxUint256,
        );
        expect(subjectData).to.eq(
          ethers.utils.defaultAbiCoder.encode(
            ["tuple(address,address,bool)[]", "uint256"],
            [
              [
                [sourceAddress, setup.weth.address, false],
                [setup.weth.address, destinationAddress, false],
              ],
              ethers.constants.MaxUint256,
            ],
          ),
        );
      });

      it("should return the correct trade calldata", async () => {
        const callTimestamp = await getLastBlockTimestamp();
        subjectData = await velodromeExchangeAdapter.generateDataParam(
          [
            { from: sourceAddress, to: setup.weth.address, stable: false },
            { from: setup.weth.address, to: destinationAddress, stable: false },
          ],
          callTimestamp,
        );
        const calldata = await subject();
        const expectedCallData = velodromeSetup.router.interface.encodeFunctionData(
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
          JSON.stringify([velodromeSetup.router.address, ZERO, expectedCallData]),
        );
      });
    });
  });
});
