import "module-alias/register";
import Web3 from "web3";

import { BigNumber } from "ethers";

import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  ADDRESS_ZERO,
  ONE,
  ZERO,
  EMPTY_BYTES,
} from "@utils/constants";
import { OneInchExchangeAdapter, OneInchExchangeMock } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
} from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getRandomAccount,
  getWaffleExpect,
} from "@utils/test/index";

const web3 = new Web3();
const expect = getWaffleExpect();


describe("OneInchExchangeAdapter", () => {
  let owner: Account;
  let mockSetToken: Account;
  let mockWbtc: Account;
  let mockWeth: Account;
  let mockOneInchSpender: Account;
  let deployer: DeployHelper;

  let oneInchExchangeMock: OneInchExchangeMock;
  let oneInchExchangeAdapter: OneInchExchangeAdapter;
  let oneInchFunctionSignature: Bytes;

  before(async () => {
    [
      owner,
      mockSetToken,
      mockWbtc,
      mockWeth,
      mockOneInchSpender,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    // Mock OneInch exchange that allows for only fixed exchange amounts
    oneInchExchangeMock = await deployer.mocks.deployOneInchExchangeMock(
      mockWbtc.address,
      mockWeth.address,
      BigNumber.from(100000000),
      ether(33)
    );
    oneInchFunctionSignature = web3.eth.abi.encodeFunctionSignature(
      "swap(address,address,uint256,uint256,uint256,address,address[],bytes,uint256[],uint256[])"
    );
    oneInchExchangeAdapter = await deployer.adapters.deployOneInchExchangeAdapter(
      mockOneInchSpender.address,
      oneInchExchangeMock.address,
      oneInchFunctionSignature
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("constructor", async () => {
    let subjectApproveAddress: Address;
    let subjectExchangeAddress: Address;
    let subjectFunctionSignature: Bytes;

    beforeEach(async () => {
      subjectApproveAddress = mockOneInchSpender.address;
      subjectExchangeAddress = oneInchExchangeMock.address;
      subjectFunctionSignature = oneInchFunctionSignature; // 1Inch swap function signature
    });

    async function subject(): Promise<any> {
      return await deployer.adapters.deployOneInchExchangeAdapter(
        subjectApproveAddress,
        subjectExchangeAddress,
        subjectFunctionSignature
      );
    }

    it("should have the correct approve address", async () => {
      const deployedOneInchExchangeAdapter = await subject();

      const actualAddress = await deployedOneInchExchangeAdapter.oneInchApprovalAddress();
      expect(actualAddress).to.eq(mockOneInchSpender.address);
    });

    it("should have the correct exchange address", async () => {
      const deployedOneInchExchangeAdapter = await subject();

      const actualAddress = await deployedOneInchExchangeAdapter.oneInchExchangeAddress();
      expect(actualAddress).to.eq(oneInchExchangeMock.address);
    });

    it("should have the correct swap function signature stored", async () => {
      const deployedOneInchExchangeAdapter = await subject();

      const actualAddress = await deployedOneInchExchangeAdapter.oneInchFunctionSignature();
      expect(actualAddress).to.eq(oneInchFunctionSignature);
    });
  });

  describe("getSpender", async () => {
    async function subject(): Promise<any> {
      return await oneInchExchangeAdapter.getSpender();
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();

      expect(spender).to.eq(mockOneInchSpender.address);
    });
  });

  describe("getTradeCalldata", async () => {
    let subjectSourceToken: Address;
    let subjectDestinationToken: Address;
    let subjectMockSetToken: Address;
    let subjectSourceQuantity: BigNumber;
    let subjectMinDestinationQuantity: BigNumber;
    let subjectData: Bytes;

    beforeEach(async () => {
      // 1inch trades only need byte data as all method call data is generaged offchain
      subjectSourceToken = mockWbtc.address;
      subjectDestinationToken = mockWeth.address;
      subjectMockSetToken = mockSetToken.address;
      subjectSourceQuantity = ONE;
      subjectMinDestinationQuantity = ONE;
      // Get mock 1inch swap calldata
      subjectData = oneInchExchangeMock.interface.encodeFunctionData("swap", [
        mockWbtc.address, // Send token
        mockWeth.address, // Receive token
        ONE, // Send quantity
        ONE, // Min receive quantity
        ZERO,
        ADDRESS_ZERO,
        [ADDRESS_ZERO],
        EMPTY_BYTES,
        [ZERO],
        [ZERO],
      ]);
    });

    async function subject(): Promise<any> {
      return await oneInchExchangeAdapter.getTradeCalldata(
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
      const expectedCallData = [oneInchExchangeMock.address, ZERO, subjectData];

      expect(JSON.stringify(calldata)).to.eq(JSON.stringify(expectedCallData));
    });

    describe("when function signature does not match", async () => {
      beforeEach(async () => {
        subjectData = EMPTY_BYTES;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Not One Inch Swap Function");
      });
    });

    describe("when send token does not match calldata", async () => {
      beforeEach(async () => {
        // Get random source token
        const randomToken = await getRandomAccount();
        subjectData = oneInchExchangeMock.interface.encodeFunctionData("swap", [
          randomToken.address, // Send token
          mockWeth.address, // Receive token
          ONE, // Send quantity
          ONE, // Min receive quantity
          ZERO,
          ADDRESS_ZERO,
          [ADDRESS_ZERO],
          EMPTY_BYTES,
          [ZERO],
          [ZERO],
        ]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid send token");
      });
    });

    describe("when receive token does not match calldata", async () => {
      beforeEach(async () => {
        // Get random source token
        const randomToken = await getRandomAccount();
        subjectData = oneInchExchangeMock.interface.encodeFunctionData("swap", [
          mockWbtc.address, // Send token
          randomToken.address, // Receive token
          ONE, // Send quantity
          ONE, // Min receive quantity
          ZERO,
          ADDRESS_ZERO,
          [ADDRESS_ZERO],
          EMPTY_BYTES,
          [ZERO],
          [ZERO],
        ]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid receive token");
      });
    });

    describe("when send token quantity does not match calldata", async () => {
      beforeEach(async () => {
        subjectData = oneInchExchangeMock.interface.encodeFunctionData("swap", [
          mockWbtc.address, // Send token
          mockWeth.address, // Receive token
          ZERO, // Send quantity
          ONE, // Min receive quantity
          ZERO,
          ADDRESS_ZERO,
          [ADDRESS_ZERO],
          EMPTY_BYTES,
          [ZERO],
          [ZERO],
        ]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Source quantity mismatch");
      });
    });

    describe("when min receive token quantity does not match calldata", async () => {
      beforeEach(async () => {
        subjectData = oneInchExchangeMock.interface.encodeFunctionData("swap", [
          mockWbtc.address, // Send token
          mockWeth.address, // Receive token
          ONE, // Send quantity
          ZERO, // Min receive quantity
          ZERO,
          ADDRESS_ZERO,
          [ADDRESS_ZERO],
          EMPTY_BYTES,
          [ZERO],
          [ZERO],
        ]);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Min destination quantity mismatch");
      });
    });
  });
});
