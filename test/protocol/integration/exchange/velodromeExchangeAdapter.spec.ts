import "module-alias/register";

import { ethers } from "hardhat";
import { BigNumber } from "ethers";
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
import { SystemFixture, VelodromeFixture } from "@utils/fixtures";

const expect = getWaffleExpect();
describe("VelodromeExchangeAdapter", () => {
  let owner: Account;
  let mockSetToken: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;
  let velodromeSetup: VelodromeFixture;
  let velodromeExchangeAdapter: VelodromeExchangeAdapter;

  let sourceAddress: Address; // wbtc
  let destinationAddress: Address; // dai
  let sourceQuantity: BigNumber;
  let destinationQuantity: BigNumber;

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

    sourceAddress = setup.wbtc.address; // WBTC Address
    sourceQuantity = BigNumber.from(100000000); // Trade 1 WBTC
    destinationAddress = setup.dai.address; // DAI Address
    destinationQuantity = ether(30000); // Receive at least 30k DAI
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

  describe("generateDataParam", async () => {
    let subjectData: Bytes;

    it("should revert with empty routes when no routes passed in", async () => {
      await expect(
        velodromeExchangeAdapter.generateDataParam([], ethers.constants.MaxUint256),
      ).to.revertedWith("empty routes");
    });

    it("should revert with invalid deadline when invalid deadline passed in", async () => {
      await expect(
        velodromeExchangeAdapter.generateDataParam(
          [
            {
              from: sourceAddress,
              to: destinationAddress,
              stable: false,
            },
          ],
          0,
        ),
      ).to.revertedWith("invalid deadline");
    });

    it("should return the correct data param for wbtc -> dai", async () => {
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

    it("should return the correct data param for wbtc -> weth -> dai", async () => {
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
  });

  describe("getTradeCalldata", async () => {
    let subjectMockSetToken: Address;
    let subjectSourceToken: Address;
    let subjectDestinationToken: Address;
    let subjectSourceQuantity: BigNumber;
    let subjectMinDestinationQuantity: BigNumber;
    let subjectData: Bytes;

    beforeEach(async () => {
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

    it("should revert with empty routes when no routes passed in", async () => {
      await expect(
        velodromeExchangeAdapter.getTradeCalldata(
          subjectSourceToken,
          subjectDestinationToken,
          subjectMockSetToken,
          subjectSourceQuantity,
          subjectMinDestinationQuantity,
          ethers.utils.defaultAbiCoder.encode(
            ["tuple(address,address,bool)[]", "uint256"],
            [[], ethers.constants.MaxUint256],
          ),
        ),
      ).to.revertedWith("empty routes");
    });

    it("should revert with source token path mismatch", async () => {
      await expect(
        velodromeExchangeAdapter.getTradeCalldata(
          subjectDestinationToken,
          subjectDestinationToken,
          subjectMockSetToken,
          subjectSourceQuantity,
          subjectMinDestinationQuantity,
          ethers.utils.defaultAbiCoder.encode(
            ["tuple(address,address,bool)[]", "uint256"],
            [[[sourceAddress, destinationAddress, false]], ethers.constants.MaxUint256],
          ),
        ),
      ).to.revertedWith("Source token path mismatch");
    });

    it("should revert with destination token path mismatch", async () => {
      await expect(
        velodromeExchangeAdapter.getTradeCalldata(
          subjectSourceToken,
          subjectSourceToken,
          subjectMockSetToken,
          subjectSourceQuantity,
          subjectMinDestinationQuantity,
          ethers.utils.defaultAbiCoder.encode(
            ["tuple(address,address,bool)[]", "uint256"],
            [[[sourceAddress, destinationAddress, false]], ethers.constants.MaxUint256],
          ),
        ),
      ).to.revertedWith("Destination token path mismatch");
    });

    it("should revert with invalid deadline when invalid deadline passed in", async () => {
      await expect(
        velodromeExchangeAdapter.getTradeCalldata(
          subjectSourceToken,
          subjectDestinationToken,
          subjectMockSetToken,
          subjectSourceQuantity,
          subjectMinDestinationQuantity,
          ethers.utils.defaultAbiCoder.encode(
            ["tuple(address,address,bool)[]", "uint256"],
            [[[sourceAddress, destinationAddress, false]], 0],
          ),
        ),
      ).to.revertedWith("invalid deadline");
    });

    it("should return the correct trade calldata for wbtc -> dai", async () => {
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

    it("should return the correct trade calldata for wbtc -> wetb -> dai", async () => {
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
