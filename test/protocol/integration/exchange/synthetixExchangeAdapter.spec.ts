import "module-alias/register";

import { BigNumber } from "ethers";

import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  EMPTY_BYTES,
  ZERO
} from "@utils/constants";

import {
  SynthetixExchangeAdapter,
  SynthMock,
  SynthetixExchangerMock,
} from "@utils/contracts";

import DeployHelper from "@utils/deploys";
import {
  ether,
} from "@utils/index";
import {
  cacheBeforeEach,
  getAccounts,
  getSystemFixture,
  getWaffleExpect,
} from "@utils/test/index";

import { SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("SynthetixExchangeAdapter", () => {
  let owner: Account;
  let mockSetToken: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let rates: any;
  let currencyKeys: any;
  let sUsd: SynthMock;
  let sEth: SynthMock;
  let sBtc: SynthMock;
  let exchanger: SynthetixExchangerMock;
  let synthetixExchangeAdapter: SynthetixExchangeAdapter;

  cacheBeforeEach(async () => {
    [
      owner,
      mockSetToken,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    // Synthetix converts everything via sUsd
    // e.g: btc => usd => eth
    // Synths are 18 decimals
    // 1 eth => 10 usd
    // 1 btc => 10 eth
    // 1 btc => 100 usd
    rates = {
      usd: {
        eth: ether(0.1),
        btc: ether(0.01),
      },
      eth: {
        usd: ether(10),
      },
      btc: {
        usd: ether(100),
      },
    };

    // Bytes32 currency key ids
    currencyKeys = {
      sUsd: "0x1111111100000000000000000000000000000000000000000000000000000000",
      sEth: "0x2222222200000000000000000000000000000000000000000000000000000000",
      sBtc: "0x3333333300000000000000000000000000000000000000000000000000000000",
      invalid : "0x4444444400000000000000000000000000000000000000000000000000000000",
    };

    sUsd = await deployer.mocks.deploySynthMock(owner.address, currencyKeys.sUsd);
    sEth = await deployer.mocks.deploySynthMock(owner.address, currencyKeys.sEth);
    sBtc = await deployer.mocks.deploySynthMock(owner.address, currencyKeys.sBtc);

    exchanger = await deployer.mocks.deploySynthetixExchangerMock(
      sUsd.address,
      sEth.address,
      sBtc.address,
      currencyKeys,
      rates
    );

    synthetixExchangeAdapter = await deployer.adapters.deploySynthetixExchangeAdapter(
      exchanger.address
    );
  });

  describe("constructor", async () => {
    let subjectExchanger: Address;

    beforeEach(async () => {
      subjectExchanger = exchanger.address;
    });

    async function subject(): Promise<any> {
      return await deployer.adapters.deploySynthetixExchangeAdapter(
        subjectExchanger
      );
    }

    it("should have the correct SynthetixExchanger address", async () => {
      const adapter = await subject();

      const actualExchangerAddress = await adapter.synthetixExchangerAddress();
      expect(actualExchangerAddress).to.eq(exchanger.address);
    });
  });

  // Test adapted from Synthetix/ExchangeRates.js:effectiveValue
  //
  // > /Synthetixio/synthetix
  // > /blob/45553ff508f62ff59d9b7eff7f2871acba20fa99
  // > /test/contracts/ExchangeRates.js#L994-L1011
  //
  describe("getAmountReceivedForExchange", async () => {
    const btcQuantity = 1;
    let subjectSourceToken: Address;
    let subjectDestinationToken: Address;
    let subjectSourceQuantity: BigNumber;

    beforeEach(async () => {
      subjectSourceToken = sBtc.address;
      subjectDestinationToken = sEth.address;
      subjectSourceQuantity = ether(btcQuantity);
    });

    async function subject(): Promise<any> {
      return await synthetixExchangeAdapter.getAmountReceivedForExchange(
        subjectSourceToken,
        subjectDestinationToken,
        subjectSourceQuantity
      );
    }

    it("should return the correct amount received", async () => {
      const actualAmountReceived = await subject();

      const conversionRate = rates.btc.usd.div(rates.eth.usd); // 10 eth/btc via usd
      const expectedAmountReceived = ether(conversionRate.mul(btcQuantity));
      expect(actualAmountReceived).to.eq(expectedAmountReceived);
    });

    describe("when source token does not implement currencyKey", () => {
      beforeEach(async () => {
        const standardToken = await deployer.mocks.deployTokenMock(owner.address);
        subjectSourceToken = standardToken.address;
      });

      it("it should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid Synth token address");
      });
    });

    describe("when destination token does not implement currencyKey", () => {
      beforeEach(async () => {
        const standardToken = await deployer.mocks.deployTokenMock(owner.address);
        subjectDestinationToken = standardToken.address;
      });

      it("it should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid Synth token address");
      });
    });
  });

  describe("getSpender", async () => {
    async function subject(): Promise<any> {
      return await synthetixExchangeAdapter.getSpender();
    }

    it("should return the correct spender address", async () => {
      const spender = await subject();

      expect(spender).to.eq(exchanger.address);
    });
  });

  describe("getTradeCalldata", async () => {
    let sourceAddress: Address;
    let destinationAddress: Address;
    let sourceQuantity: BigNumber;
    let sourceCurrencyKey: Bytes;
    let destinationCurrencyKey: Bytes;

    let subjectMockSetToken: Address;
    let subjectSourceToken: Address;
    let subjectDestinationToken: Address;
    let subjectSourceQuantity: BigNumber;
    let subjectMinDestinationQuantity: BigNumber;
    let subjectData: Bytes;

    beforeEach(async () => {
      sourceAddress = sEth.address,
      destinationAddress = sBtc.address,
      sourceCurrencyKey = currencyKeys.sEth;       // sEth currency key
      destinationCurrencyKey = currencyKeys.sBtc;  // sBtc currency key
      sourceQuantity = ether(10);                  // 10 eth => 1 Btc

      subjectSourceToken = sourceAddress;
      subjectDestinationToken = destinationAddress;
      subjectMockSetToken = mockSetToken.address;
      subjectSourceQuantity = sourceQuantity;
      subjectMinDestinationQuantity = ZERO;
      subjectData = EMPTY_BYTES;
    });

    async function subject(): Promise<any> {
      return await synthetixExchangeAdapter.getTradeCalldata(
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

      const expectedCallData = exchanger.interface.encodeFunctionData("exchange", [
        mockSetToken.address,
        sourceCurrencyKey,
        sourceQuantity,
        destinationCurrencyKey,
        mockSetToken.address,
      ]);
      expect(JSON.stringify(calldata)).to
        .eq(JSON.stringify([exchanger.address, ZERO, expectedCallData]));
    });

    describe("when source token and destination token addresses are the same", () => {
      beforeEach(() => {
        subjectSourceToken = sEth.address;
        subjectDestinationToken = sEth.address;
      });

      it("it should revert", async () => {
        await expect(subject()).to.be.revertedWith("Source token cannot be same as destination token");
      });
    });

    describe("when source token does not implement currencyKey", () => {
      beforeEach(async () => {
        const standardToken = await deployer.mocks.deployTokenMock(owner.address);
        subjectSourceToken = standardToken.address;
      });

      it("it should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid Synth token address");
      });
    });

    describe("when destination token does not implement currencyKey", () => {
      beforeEach(async () => {
        const standardToken = await deployer.mocks.deployTokenMock(owner.address);
        subjectDestinationToken = standardToken.address;
      });

      it("it should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid Synth token address");
      });
    });
  });
});
