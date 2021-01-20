import "module-alias/register";

import { Account } from "@utils/test/types";
import { ADDRESS_ZERO, ONE, ZERO, EMPTY_BYTES } from "@utils/constants";
import { ZeroExApiAdapter, ZeroExMock } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import { addSnapshotBeforeRestoreAfterEach, getAccounts, getWaffleExpect } from "@utils/test/index";

const expect = getWaffleExpect();

describe("ZeroExApiAdapter", () => {
  let owner: Account;
  const sourceToken = "0x6cf5f1d59fddae3a688210953a512b6aee6ea643";
  const destToken = "0x5e5d0bea9d4a15db2d0837aff0435faba166190d";
  const otherToken = "0xae9902bb655de1a67f334d8661b3ae6a96723d5b";
  const destination = "0x89b3515cad4f23c1deacea79fc12445cc21bd0e1";
  const otherDestination = "0xdeb100c55cccfd6e39753f78c8b0c3bcbef86157";
  const sourceQuantity = ONE;
  const minDestinationQuantity = ONE.mul(2);
  const otherQuantity = ONE.div(2);
  let deployer: DeployHelper;

  let zeroExMock: ZeroExMock;
  let zeroExApiAdapter: ZeroExApiAdapter;

  before(async () => {
    [owner] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    // Mock OneInch exchange that allows for only fixed exchange amounts
    zeroExMock = await deployer.mocks.deployZeroExMock();
    zeroExApiAdapter = await deployer.adapters.deployZeroExApiAdapter(zeroExMock.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("getTradeCalldata", () => {
    it("rejects unsupported function", async () => {
      const data = zeroExMock.interface.encodeFunctionData("transformERC20", [
        sourceToken,
        destToken,
        sourceQuantity,
        minDestinationQuantity,
        [],
      ]);
      const tx = zeroExApiAdapter.getTradeCalldata(
        sourceToken,
        destToken,
        destination,
        sourceQuantity,
        minDestinationQuantity,
        "0x01234567" + data.slice(10),
      );
      await expect(tx).to.be.revertedWith("Unsupported 0xAPI function selector");
    });

    describe("transformERC20", () => {
      it("validates data", async () => {
        const data = zeroExMock.interface.encodeFunctionData("transformERC20", [
          sourceToken,
          destToken,
          sourceQuantity,
          minDestinationQuantity,
          [],
        ]);
        const [target, value, _data] = await zeroExApiAdapter.getTradeCalldata(
          sourceToken,
          destToken,
          destination,
          sourceQuantity,
          minDestinationQuantity,
          data,
        );
        expect(target).to.eq(zeroExMock.address);
        expect(value).to.deep.eq(ZERO);
        expect(_data).to.deep.eq(data);
      });

      it("rejects wrong input token", async () => {
        const data = zeroExMock.interface.encodeFunctionData("transformERC20", [
          otherToken,
          destToken,
          sourceQuantity,
          minDestinationQuantity,
          [],
        ]);
        const tx = zeroExApiAdapter.getTradeCalldata(
          sourceToken,
          destToken,
          destination,
          sourceQuantity,
          minDestinationQuantity,
          data,
        );
        await expect(tx).to.be.revertedWith("Mismatched input token");
      });

      it("rejects wrong output token", async () => {
        const data = zeroExMock.interface.encodeFunctionData("transformERC20", [
          sourceToken,
          otherToken,
          sourceQuantity,
          minDestinationQuantity,
          [],
        ]);
        const tx = zeroExApiAdapter.getTradeCalldata(
          sourceToken,
          destToken,
          destination,
          sourceQuantity,
          minDestinationQuantity,
          data,
        );
        await expect(tx).to.be.revertedWith("Mismatched output token");
      });

      it("rejects wrong input token quantity", async () => {
        const data = zeroExMock.interface.encodeFunctionData("transformERC20", [
          sourceToken,
          destToken,
          otherQuantity,
          minDestinationQuantity,
          [],
        ]);
        const tx = zeroExApiAdapter.getTradeCalldata(
          sourceToken,
          destToken,
          destination,
          sourceQuantity,
          minDestinationQuantity,
          data,
        );
        await expect(tx).to.be.revertedWith("Mismatched input token quantity");
      });

      it("rejects wrong output token quantity", async () => {
        const data = zeroExMock.interface.encodeFunctionData("transformERC20", [
          sourceToken,
          destToken,
          sourceQuantity,
          otherQuantity,
          [],
        ]);
        const tx = zeroExApiAdapter.getTradeCalldata(
          sourceToken,
          destToken,
          destination,
          sourceQuantity,
          minDestinationQuantity,
          data,
        );
        await expect(tx).to.be.revertedWith("Mismatched output token quantity");
      });
    });

    describe("sellToUniswap", () => {
      it("validates data", async () => {
        const data = zeroExMock.interface.encodeFunctionData("sellToUniswap", [
          [sourceToken, destToken],
          sourceQuantity,
          minDestinationQuantity,
          false,
        ]);
        const [target, value, _data] = await zeroExApiAdapter.getTradeCalldata(
          sourceToken,
          destToken,
          destination,
          sourceQuantity,
          minDestinationQuantity,
          data,
        );
        expect(target).to.eq(zeroExMock.address);
        expect(value).to.deep.eq(ZERO);
        expect(_data).to.deep.eq(data);
      });

      it("rejects wrong input token", async () => {
        const data = zeroExMock.interface.encodeFunctionData("sellToUniswap", [
          [otherToken, destToken],
          sourceQuantity,
          minDestinationQuantity,
          false,
        ]);
        const tx = zeroExApiAdapter.getTradeCalldata(
          sourceToken,
          destToken,
          destination,
          sourceQuantity,
          minDestinationQuantity,
          data,
        );
        await expect(tx).to.be.revertedWith("Mismatched input token");
      });

      it("rejects wrong output token", async () => {
        const data = zeroExMock.interface.encodeFunctionData("sellToUniswap", [
          [sourceToken, otherToken],
          sourceQuantity,
          minDestinationQuantity,
          false,
        ]);
        const tx = zeroExApiAdapter.getTradeCalldata(
          sourceToken,
          destToken,
          destination,
          sourceQuantity,
          minDestinationQuantity,
          data,
        );
        await expect(tx).to.be.revertedWith("Mismatched output token");
      });

      it("rejects wrong input token quantity", async () => {
        const data = zeroExMock.interface.encodeFunctionData("sellToUniswap", [
          [sourceToken, destToken],
          otherQuantity,
          minDestinationQuantity,
          false,
        ]);
        const tx = zeroExApiAdapter.getTradeCalldata(
          sourceToken,
          destToken,
          destination,
          sourceQuantity,
          minDestinationQuantity,
          data,
        );
        await expect(tx).to.be.revertedWith("Mismatched input token quantity");
      });

      it("rejects wrong output token quantity", async () => {
        const data = zeroExMock.interface.encodeFunctionData("sellToUniswap", [
          [sourceToken, destToken],
          sourceQuantity,
          otherQuantity,
          false,
        ]);
        const tx = zeroExApiAdapter.getTradeCalldata(
          sourceToken,
          destToken,
          destination,
          sourceQuantity,
          minDestinationQuantity,
          data,
        );
        await expect(tx).to.be.revertedWith("Mismatched output token quantity");
      });
    });

    describe("sellToLiquidityProvider", () => {
      it("validates data", async () => {
        const data = zeroExMock.interface.encodeFunctionData("sellToLiquidityProvider", [
          sourceToken,
          destToken,
          ADDRESS_ZERO,
          destination,
          sourceQuantity,
          minDestinationQuantity,
          EMPTY_BYTES,
        ]);
        const [target, value, _data] = await zeroExApiAdapter.getTradeCalldata(
          sourceToken,
          destToken,
          destination,
          sourceQuantity,
          minDestinationQuantity,
          data,
        );
        expect(target).to.eq(zeroExMock.address);
        expect(value).to.deep.eq(ZERO);
        expect(_data).to.deep.eq(data);
      });

      it("rejects wrong input token", async () => {
        const data = zeroExMock.interface.encodeFunctionData("sellToLiquidityProvider", [
          otherToken,
          destToken,
          ADDRESS_ZERO,
          destination,
          sourceQuantity,
          minDestinationQuantity,
          EMPTY_BYTES,
        ]);
        const tx = zeroExApiAdapter.getTradeCalldata(
          sourceToken,
          destToken,
          destination,
          sourceQuantity,
          minDestinationQuantity,
          data,
        );
        await expect(tx).to.be.revertedWith("Mismatched input token");
      });

      it("rejects wrong output token", async () => {
        const data = zeroExMock.interface.encodeFunctionData("sellToLiquidityProvider", [
          sourceToken,
          otherToken,
          ADDRESS_ZERO,
          destination,
          sourceQuantity,
          minDestinationQuantity,
          EMPTY_BYTES,
        ]);
        const tx = zeroExApiAdapter.getTradeCalldata(
          sourceToken,
          destToken,
          destination,
          sourceQuantity,
          minDestinationQuantity,
          data,
        );
        await expect(tx).to.be.revertedWith("Mismatched output token");
      });

      it("rejects wrong input token quantity", async () => {
        const data = zeroExMock.interface.encodeFunctionData("sellToLiquidityProvider", [
          sourceToken,
          destToken,
          ADDRESS_ZERO,
          destination,
          otherQuantity,
          minDestinationQuantity,
          EMPTY_BYTES,
        ]);
        const tx = zeroExApiAdapter.getTradeCalldata(
          sourceToken,
          destToken,
          destination,
          sourceQuantity,
          minDestinationQuantity,
          data,
        );
        await expect(tx).to.be.revertedWith("Mismatched input token quantity");
      });

      it("rejects wrong output token quantity", async () => {
        const data = zeroExMock.interface.encodeFunctionData("sellToLiquidityProvider", [
          sourceToken,
          destToken,
          ADDRESS_ZERO,
          destination,
          sourceQuantity,
          otherQuantity,
          EMPTY_BYTES,
        ]);
        const tx = zeroExApiAdapter.getTradeCalldata(
          sourceToken,
          destToken,
          destination,
          sourceQuantity,
          minDestinationQuantity,
          data,
        );
        await expect(tx).to.be.revertedWith("Mismatched output token quantity");
      });

      it("rejects wrong destination", async () => {
        const data = zeroExMock.interface.encodeFunctionData("sellToLiquidityProvider", [
          sourceToken,
          destToken,
          ADDRESS_ZERO,
          otherDestination,
          sourceQuantity,
          otherQuantity,
          EMPTY_BYTES,
        ]);
        const tx = zeroExApiAdapter.getTradeCalldata(
          sourceToken,
          destToken,
          destination,
          sourceQuantity,
          minDestinationQuantity,
          data,
        );
        await expect(tx).to.be.revertedWith("Mismatched recipient");
      });
    });
  });
});
