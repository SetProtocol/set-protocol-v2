import "module-alias/register";
import { ethers } from "hardhat";
import { BigNumber } from "@ethersproject/bignumber";
import { ContractTransaction } from "ethers";

import { Account, Address } from "@utils/types";
import { Controller, PriceOracle, OracleAdapterMock, OracleMock } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getRandomAccount,
  getWaffleExpect
} from "@utils/index";

const expect = getWaffleExpect();

const inverse = (number: BigNumber): BigNumber => {
  return ether(1).mul(ether(1)).div(number);
};


describe("PriceOracle", () => {
  let wallet: Account;

  let ethusdcOracle: OracleMock;
  let ethbtcOracle: OracleMock;

  let wrappedETH: Account;
  let wrappedBTC: Account;
  let usdc: Account;
  let adapterAsset: Account;
  let randomAsset: Account;
  let newOracle: Account;
  let attacker: Account;
  let subjectCaller: Account;

  let initialETHValue: BigNumber;
  let initialETHBTCValue: BigNumber;
  let adapterDummyPrice: BigNumber;

  let controller: Controller;
  let oracleAdapter: OracleAdapterMock;
  let masterOracle: PriceOracle;
  let deployer: DeployHelper;

  addSnapshotBeforeRestoreAfterEach();

  beforeEach(async () => {
    // Using this syntax for sol-coverage to work
    [wallet, wrappedETH, wrappedBTC, usdc, adapterAsset, randomAsset, newOracle, attacker] = await getAccounts();

    deployer = new DeployHelper(wallet.wallet);

    initialETHValue = ether(235);
    initialETHBTCValue = ether(0.025);
    ethusdcOracle = await deployer.mocks.deployOracleMock(initialETHValue);
    ethbtcOracle = await deployer.mocks.deployOracleMock(initialETHBTCValue);

    adapterDummyPrice = ether(5);
    oracleAdapter = await deployer.mocks.deployOracleAdapterMock(adapterAsset.address, adapterDummyPrice);

    controller = await deployer.core.deployController(wallet.address);
    await controller.initialize([], [wallet.address], [], []);

    masterOracle = await deployer.core.deployPriceOracle(
      controller.address,
      wrappedETH.address,
      [oracleAdapter.address],
      [wrappedETH.address, wrappedETH.address],
      [usdc.address, wrappedBTC.address],
      [ethusdcOracle.address, ethbtcOracle.address],
    );

    subjectCaller = wallet;
  });

  describe("constructor", async () => {
    let subjectController: Address;
    let subjectMasterQuoteAsset: Address;
    let subjectAssetOnes: Address[];
    let subjectAssetTwos: Address[];
    let subjectOracles: Address[];
    let subjectAdapters: Address[];

    beforeEach(async () => {
      subjectController = controller.address,
      subjectMasterQuoteAsset = wrappedETH.address;
      subjectAssetOnes = [wrappedETH.address, wrappedETH.address];
      subjectAssetTwos = [usdc.address, wrappedBTC.address];
      subjectOracles = [ethusdcOracle.address, ethbtcOracle.address];
      subjectAdapters = [oracleAdapter.address];
    });

    async function subject(): Promise<PriceOracle> {
      return deployer.core.deployPriceOracle(
        subjectController,
        subjectMasterQuoteAsset,
        subjectAdapters,
        subjectAssetOnes,
        subjectAssetTwos,
        subjectOracles,
      );
    }

    it("should have the correct controller address", async () => {
      const masterOracle = await subject();

      const actualController = await masterOracle.controller();
      expect(actualController).to.eq(subjectController);
    });

    it("should have the correct masterQuoteAsset address", async () => {
      const masterOracle = await subject();

      const actualMasterQuoteAsset = await masterOracle.masterQuoteAsset();
      expect(actualMasterQuoteAsset).to.eq(subjectMasterQuoteAsset);
    });

    it("should have the correct oracle adapters", async () => {
      const masterOracle = await subject();

      const actualOracleAdapters = await masterOracle.getAdapters();
      expect(JSON.stringify(actualOracleAdapters)).to.eq(JSON.stringify(subjectAdapters));
    });

    it("should have the oracles mapped correctly", async () => {
      const masterOracle = await subject();

      const oracleOne = await masterOracle.oracles(subjectAssetOnes[0], subjectAssetTwos[0]);
      const oracleTwo = await masterOracle.oracles(subjectAssetOnes[1], subjectAssetTwos[1]);
      expect(oracleOne).to.eq(subjectOracles[0]);
      expect(oracleTwo).to.eq(subjectOracles[1]);
    });

    describe("when the assetOnes and assetTwos arrays are different lengths", async () => {
      beforeEach(async () => {
        subjectAssetOnes = [wrappedETH.address];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Array lengths do not match.");
      });
    });

    describe("when the assetTwos and oracles arrays are different lengths", async () => {
      beforeEach(async () => {
        subjectOracles = [ethusdcOracle.address];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Array lengths do not match.");
      });
    });
  });

  describe("getPrice", async () => {
    let subjectAssetOne: Address;
    let subjectAssetTwo: Address;

    beforeEach(async () => {
      subjectAssetOne = wrappedETH.address;
      subjectAssetTwo = usdc.address;
    });

    async function subject(): Promise<BigNumber> {
      masterOracle = masterOracle.connect(subjectCaller.wallet);
      return masterOracle.getPrice(
        subjectAssetOne,
        subjectAssetTwo
      );
    }

    it("should return the price", async () => {
      const actualPrice = await subject();

      const expectedPrice = await ethusdcOracle.read();
      expect(actualPrice).to.eq(expectedPrice);
    });

    describe("when an inverse price is requested", async () => {
      beforeEach(async () => {
        subjectAssetOne = usdc.address;
        subjectAssetTwo = wrappedETH.address;
      });

      it("should return inverse price", async () => {
        const actualPrice = await subject();

        const expectedPrice = inverse(initialETHValue);
        expect(actualPrice).to.eq(expectedPrice);
      });
    });

    describe("when the master quote asset must be used", async () => {
      beforeEach(async () => {
        subjectAssetOne = wrappedBTC.address;
        subjectAssetTwo = usdc.address;
      });

      it("should return price computed with two oracles", async () => {
        const actualPrice = await subject();

        const expectedPrice = inverse(initialETHBTCValue).mul(ether(1)).div(inverse(initialETHValue));
        expect(actualPrice).to.eq(expectedPrice);
      });
    });

    describe("when the price is on an adapter", async () => {
      beforeEach(async () => {
        subjectAssetOne = adapterAsset.address;
        subjectAssetTwo = usdc.address;
      });

      it("should return price computed by adapter", async () => {
        const actualPrice = await subject();

        expect(actualPrice).to.eq(adapterDummyPrice);
      });
    });

    describe("when there is no price for the asset pair", async () => {
      beforeEach(async () => {
        subjectAssetOne = randomAsset.address;
        subjectAssetTwo = usdc.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("PriceOracle.getPrice: Price not found.");
      });
    });

    describe("when the caller is not a system contract (i.e. external party seeking access to data)", async () => {
      beforeEach(async () => {
        subjectCaller = attacker;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("PriceOracle.getPrice: Caller must be system contract.");
      });
    });
  });

  describe("editPair", async () => {
    let subjectAssetOne: Address;
    let subjectAssetTwo: Address;
    let subjectOracle: Address;

    beforeEach(async () => {
      subjectAssetOne = wrappedETH.address;
      subjectAssetTwo = usdc.address;
      subjectOracle = newOracle.address;
    });

    async function subject(): Promise<ContractTransaction> {
      masterOracle = masterOracle.connect(subjectCaller.wallet);
      return masterOracle.editPair(
        subjectAssetOne,
        subjectAssetTwo,
        subjectOracle
      );
    }

    it("should replace the old oracle", async () => {
      await subject();

      const actualOracle = await masterOracle.oracles(subjectAssetOne, subjectAssetTwo);
      expect(actualOracle).to.eq(subjectOracle);
    });

    it("should emit an PairEdited event", async () => {
      await expect(subject()).to.emit(masterOracle, "PairEdited").withArgs(
        subjectAssetOne,
        subjectAssetTwo,
        subjectOracle,
      );
    });

    shouldRevertIfNotOwner(subject);

    describe("when the asset pair doesn't have an oracle", async () => {
      beforeEach(async () => {
        subjectAssetOne = randomAsset.address;
        subjectAssetTwo = usdc.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("PriceOracle.editPair: Pair doesn't exist.");
      });
    });
  });

  describe("addPair", async () => {
    let subjectAssetOne: Address;
    let subjectAssetTwo: Address;
    let subjectOracle: Address;

    beforeEach(async () => {
      subjectAssetOne = randomAsset.address;
      subjectAssetTwo = usdc.address;
      subjectOracle = newOracle.address;
    });

    async function subject(): Promise<ContractTransaction> {
      masterOracle = masterOracle.connect(subjectCaller.wallet);
      return masterOracle.addPair(
        subjectAssetOne,
        subjectAssetTwo,
        subjectOracle
      );
    }

    it("should create the new oracle record", async () => {
      await subject();

      const actualOracle = await masterOracle.oracles(subjectAssetOne, subjectAssetTwo);
      expect(actualOracle).to.eq(subjectOracle);
    });

    it("should emit an PairAdded event", async () => {
      await expect(subject()).to.emit(masterOracle, "PairAdded").withArgs(subjectAssetOne, subjectAssetTwo, subjectOracle);
    });

    shouldRevertIfNotOwner(subject);

    describe("when the asset pair already has an oracle", async () => {
      beforeEach(async () => {
        subjectAssetOne = wrappedETH.address;
        subjectAssetTwo = usdc.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("PriceOracle.addPair: Pair already exists.");
      });
    });
  });

  describe("removePair", async () => {
    let subjectAssetOne: Address;
    let subjectAssetTwo: Address;

    beforeEach(async () => {
      subjectAssetOne = wrappedETH.address;
      subjectAssetTwo = usdc.address;
    });

    async function subject(): Promise<ContractTransaction> {
      masterOracle = masterOracle.connect(subjectCaller.wallet);
      return masterOracle.removePair(
        subjectAssetOne,
        subjectAssetTwo,
      );
    }

    it("should remove the old oracle", async () => {
      await subject();

      const actualOracle = await masterOracle.oracles(subjectAssetOne, subjectAssetTwo);
      expect(actualOracle).to.eq(ethers.constants.AddressZero);
    });

    it("should emit an PairRemoved event", async () => {
      const oldOracle = await masterOracle.oracles(subjectAssetOne, subjectAssetTwo);
      await expect(subject()).to.emit(masterOracle, "PairRemoved").withArgs(subjectAssetOne, subjectAssetTwo, oldOracle);
    });

    shouldRevertIfNotOwner(subject);

    describe("when the asset pair doesn't have an oracle", async () => {
      beforeEach(async () => {
        subjectAssetOne = randomAsset.address;
        subjectAssetTwo = usdc.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("PriceOracle.removePair: Pair doesn't exist.");
      });
    });
  });

  describe("addAdapter", async () => {
    let subjectAdapter: Address;

    beforeEach(async () => {
      subjectAdapter = randomAsset.address;
    });

    async function subject(): Promise<ContractTransaction> {
      masterOracle = masterOracle.connect(subjectCaller.wallet);
      return masterOracle.addAdapter(
        subjectAdapter,
      );
    }

    it("should add new adapter", async () => {
      await subject();

      const adapters = await masterOracle.getAdapters();
      expect(adapters).to.contain(subjectAdapter);
    });

    it("should emit an AdapterAdded event", async () => {
      await expect(subject()).to.emit(masterOracle, "AdapterAdded").withArgs(subjectAdapter);
    });

    shouldRevertIfNotOwner(subject);

    describe("when the adapter already exists", async () => {
      beforeEach(async () => {
        subjectAdapter = oracleAdapter.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("PriceOracle.addAdapter: Adapter already exists.");
      });
    });
  });

  describe("removeAdapter", async () => {
    let subjectAdapter: Address;

    beforeEach(async () => {
      subjectAdapter = oracleAdapter.address;
    });

    async function subject(): Promise<ContractTransaction> {
      masterOracle = masterOracle.connect(subjectCaller.wallet);
      return masterOracle.removeAdapter(
        subjectAdapter,
      );
    }

    it("should remove adapter", async () => {
      await subject();

      const adapters = await masterOracle.getAdapters();
      expect(adapters).to.not.contain(subjectAdapter);
    });

    it("should emit an AdapterRemoved event", async () => {
      await expect(subject()).to.emit(masterOracle, "AdapterRemoved").withArgs(subjectAdapter);
    });

    shouldRevertIfNotOwner(subject);

    describe("when the adapter does not exist", async () => {
      beforeEach(async () => {
        subjectAdapter = randomAsset.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("PriceOracle.removeAdapter: Adapter does not exist.");
      });
    });
  });

  describe("editMasterQuoteAsset", async () => {
    let subjectNewMasterQuoteAsset: Address;

    beforeEach(async () => {
      subjectNewMasterQuoteAsset = usdc.address;
    });

    async function subject(): Promise<ContractTransaction> {
      masterOracle = masterOracle.connect(subjectCaller.wallet);
      return masterOracle.editMasterQuoteAsset(
        subjectNewMasterQuoteAsset
      );
    }

    it("should change the master quote asset", async () => {
      await subject();

      const actualMasterQuoteAsset = await masterOracle.masterQuoteAsset();
      expect(actualMasterQuoteAsset).to.eq(subjectNewMasterQuoteAsset);
    });

    it("should emit an MasterQuoteAssetEdited event", async () => {
      await expect(subject()).to.emit(masterOracle, "MasterQuoteAssetEdited").withArgs(
        subjectNewMasterQuoteAsset,
      );
    });

    shouldRevertIfNotOwner(subject);
  });

  function shouldRevertIfNotOwner(subject: any) {
    describe("when the caller is not owner", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  }
});