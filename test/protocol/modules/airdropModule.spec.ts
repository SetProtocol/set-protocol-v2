import "module-alias/register";
import { BigNumber } from "ethers";

import { Address, ContractTransaction } from "@utils/types";
import { Account } from "@utils/test/types";
import { ZERO, PRECISE_UNIT, ADDRESS_ZERO } from "@utils/constants";
import { AirdropModule, SetToken } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
  preciseMul,
  preciseDiv,
} from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  getRandomAddress,
} from "@utils/test/index";
import { SystemFixture } from "@utils/fixtures";
import { AirdropSettings } from "@utils/types";

const expect = getWaffleExpect();

describe("AirdropModule", () => {
  let owner: Account;
  let feeRecipient: Account;
  let tokenHolder: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let setToken: SetToken;
  let airdropModule: AirdropModule;

  before(async () => {
    [
      owner,
      feeRecipient,
      tokenHolder,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    airdropModule = await deployer.modules.deployAirdropModule(setup.controller.address);
    await setup.controller.addModule(airdropModule.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#initialize", async () => {
    let airdrops: Address[];
    let airdropFee: BigNumber;
    let anyoneAbsorb: boolean;
    let airdropFeeRecipient: Address;

    let subjectSetToken: Address;
    let subjectAirdropSettings: AirdropSettings;
    let subjectCaller: Account;

    before(async () => {
      airdrops = [setup.usdc.address, setup.weth.address];
      airdropFee = ether(.2);
      anyoneAbsorb = true;
      airdropFeeRecipient = feeRecipient.address;
    });

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [airdropModule.address]
      );

      subjectSetToken = setToken.address;
      subjectAirdropSettings = {
        airdrops,
        feeRecipient: airdropFeeRecipient,
        airdropFee,
        anyoneAbsorb,
      } as AirdropSettings;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      airdropModule = airdropModule.connect(subjectCaller.wallet);
      return airdropModule.initialize(subjectSetToken, subjectAirdropSettings);
    }

    it("should set the correct airdrops and anyoneAbsorb fields", async () => {
      await subject();

      const airdropSettings: any = await airdropModule.airdropSettings(subjectSetToken);
      const airdrops = await airdropModule.getAirdrops(subjectSetToken);

      expect(JSON.stringify(airdrops)).to.eq(JSON.stringify(airdrops));
      expect(airdropSettings.airdropFee).to.eq(airdropFee);
      expect(airdropSettings.anyoneAbsorb).to.eq(anyoneAbsorb);
    });

    it("should set the correct isAirdrop state", async () => {
      await subject();

      const wethIsAirdrop = await airdropModule.isAirdrop(subjectSetToken, setup.weth.address);
      const usdcIsAirdrop = await airdropModule.isAirdrop(subjectSetToken, setup.usdc.address);

      expect(wethIsAirdrop).to.be.true;
      expect(usdcIsAirdrop).to.be.true;
    });

    describe("when the airdrops array is empty", async () => {
      before(async () => {
        airdrops = [];
      });

      after(async () => {
        airdrops = [setup.usdc.address, setup.weth.address];
      });

      it("should set the airdrops with an empty array", async () => {
        await subject();

        const airdrops = await airdropModule.getAirdrops(subjectSetToken);

        expect(airdrops).to.be.empty;
      });
    });

    describe("when there are duplicate components in the airdrops array", async () => {
      before(async () => {
        airdrops = [setup.weth.address, setup.weth.address];
      });

      after(async () => {
        airdrops = [setup.usdc.address, setup.weth.address];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Duplicate airdrop token passed");
      });
    });

    describe("when the airdrop fee is greater than 100%", async () => {
      before(async () => {
        airdropFee = ether(1.01);
      });

      after(async () => {
        airdropFee = ether(.2);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Fee must be <= 100%.");
      });
    });

    describe("when the fee recipient is the ZERO_ADDRESS", async () => {
      before(async () => {
        airdropFeeRecipient = ADDRESS_ZERO;
      });

      after(async () => {
        airdropFeeRecipient = feeRecipient.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Zero fee address passed");
      });
    });

    describe("when the caller is not the SetToken manager", async () => {
      beforeEach(async () => {
        subjectCaller = tokenHolder;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
      });
    });

    describe("when module is in NONE state", async () => {
      beforeEach(async () => {
        await subject();
        await setToken.removeModule(airdropModule.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when module is in INITIALIZED state", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the SetToken is not enabled on the controller", async () => {
      beforeEach(async () => {
        const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
          [setup.weth.address],
          [ether(1)],
          [airdropModule.address]
        );

        subjectSetToken = nonEnabledSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be controller-enabled SetToken");
      });
    });
  });

  describe("#batchAbsorb", async () => {
    let airdrops: Address[];
    let airdropFee: BigNumber;
    let anyoneAbsorb: boolean;

    let airdropAmounts: BigNumber[];
    let protocolFee: BigNumber;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectTokens: Address[];
    let subjectCaller: Account;

    before(async () => {
      airdrops = [setup.usdc.address, setup.weth.address];
      airdropFee = ether(.2);
      anyoneAbsorb = true;

      protocolFee = ether(.15);
      airdropAmounts = [BigNumber.from(10 ** 10), ether(2)];
      isInitialized = true;
    });

    beforeEach(async () => {
      await setup.controller.addFee(airdropModule.address, ZERO, protocolFee);
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [airdropModule.address, setup.issuanceModule.address]
      );

      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      if (isInitialized) {
        const airdropSettings = {
          airdrops,
          feeRecipient: feeRecipient.address,
          airdropFee,
          anyoneAbsorb,
        };
        await airdropModule.connect(owner.wallet).initialize(setToken.address, airdropSettings);
      }

      await setup.issuanceModule.issue(setToken.address, ether(1.124), owner.address);

      await setup.usdc.transfer(setToken.address, airdropAmounts[0]);
      await setup.weth.transfer(setToken.address, airdropAmounts[1]);

      subjectSetToken = setToken.address;
      subjectTokens = [setup.usdc.address, setup.weth.address];
      subjectCaller = tokenHolder;
    });

    async function subject(): Promise<ContractTransaction> {
      return airdropModule.connect(subjectCaller.wallet).batchAbsorb(subjectSetToken, subjectTokens);
    }

    it("should create the correct new usdc position", async () => {
      const totalSupply = await setToken.totalSupply();
      const preDropBalance = ZERO;
      const balance = await setup.usdc.balanceOf(setToken.address);

      await subject();

      const airdroppedTokens = balance.sub(preDropBalance);
      const netBalance = balance.sub(preciseMul(airdroppedTokens, airdropFee));

      const positions = await setToken.getPositions();
      expect(positions[1].unit).to.eq(preciseDiv(netBalance, totalSupply));
    });

    it("should transfer the correct usdc amount to the setToken feeRecipient", async () => {
      const preDropBalance = ZERO;
      const balance = await setup.usdc.balanceOf(setToken.address);

      await subject();

      const airdroppedTokens = balance.sub(preDropBalance);
      const expectedManagerTake = preciseMul(preciseMul(airdroppedTokens, airdropFee), PRECISE_UNIT.sub(protocolFee));

      const actualManagerTake = await setup.usdc.balanceOf(feeRecipient.address);
      expect(actualManagerTake).to.eq(expectedManagerTake);
    });

    it("should transfer the correct usdc amount to the protocol feeRecipient", async () => {
      const preDropBalance = ZERO;
      const balance = await setup.usdc.balanceOf(setToken.address);

      await subject();

      const airdroppedTokens = balance.sub(preDropBalance);
      const expectedProtocolTake = preciseMul(preciseMul(airdroppedTokens, airdropFee), protocolFee);
      const actualProtocolTake = await setup.usdc.balanceOf(setup.feeRecipient);
      expect(actualProtocolTake).to.eq(expectedProtocolTake);
    });

    it("should emit the correct ComponentAbsorbed event for USDC", async () => {
      const preDropBalance = ZERO;
      const balance = await setup.usdc.balanceOf(setToken.address);

      const airdroppedTokens = balance.sub(preDropBalance);
      const expectedManagerTake = preciseMul(preciseMul(airdroppedTokens, airdropFee), PRECISE_UNIT.sub(protocolFee));
      const expectedProtocolTake = preciseMul(preciseMul(airdroppedTokens, airdropFee), protocolFee);
      await expect(subject()).to.emit(airdropModule, "ComponentAbsorbed").withArgs(
        setToken.address,
        setup.usdc.address,
        airdroppedTokens,
        expectedManagerTake,
        expectedProtocolTake
      );
    });

    it("should create the correct new eth position", async () => {
      const totalSupply = await setToken.totalSupply();
      const prePositions = await setToken.getPositions();
      const preDropBalance = preciseMul(prePositions[0].unit, totalSupply);
      const balance = await setup.weth.balanceOf(setToken.address);

      await subject();

      const airdroppedTokens = balance.sub(preDropBalance);
      const netBalance = balance.sub(preciseMul(airdroppedTokens, airdropFee));

      const positions = await setToken.getPositions();
      expect(positions[0].unit).to.eq(preciseDiv(netBalance, totalSupply));
    });

    it("should transfer the correct weth amount to the setToken feeRecipient", async () => {
      const totalSupply = await setToken.totalSupply();
      const prePositions = await setToken.getPositions();
      const preDropBalance = preciseMul(prePositions[0].unit, totalSupply);
      const balance = await setup.weth.balanceOf(setToken.address);

      await subject();

      const airdroppedTokens = balance.sub(preDropBalance);
      const expectedManagerTake = preciseMul(preciseMul(airdroppedTokens, airdropFee), PRECISE_UNIT.sub(protocolFee));

      const actualManagerTake = await setup.weth.balanceOf(feeRecipient.address);
      expect(actualManagerTake).to.eq(expectedManagerTake);
    });

    it("should transfer the correct weth amount to the protocol feeRecipient", async () => {
      const totalSupply = await setToken.totalSupply();
      const prePositions = await setToken.getPositions();
      const preDropBalance = preciseMul(prePositions[0].unit, totalSupply);
      const balance = await setup.weth.balanceOf(setToken.address);

      await subject();

      const airdroppedTokens = balance.sub(preDropBalance);
      const expectedProtocolTake = preciseMul(preciseMul(airdroppedTokens, airdropFee), protocolFee);

      const actualProtocolTake = await setup.weth.balanceOf(setup.feeRecipient);
      expect(actualProtocolTake).to.eq(expectedProtocolTake);
    });

    it("should emit the correct ComponentAbsorbed event for WETH", async () => {
      const totalSupply = await setToken.totalSupply();
      const prePositions = await setToken.getPositions();
      const preDropBalance = preciseMul(prePositions[0].unit, totalSupply);
      const balance = await setup.weth.balanceOf(setToken.address);

      const airdroppedTokens = balance.sub(preDropBalance);
      const expectedManagerTake = preciseMul(preciseMul(airdroppedTokens, airdropFee), PRECISE_UNIT.sub(protocolFee));
      const expectedProtocolTake = preciseMul(preciseMul(airdroppedTokens, airdropFee), protocolFee);
      await expect(subject()).to.emit(airdropModule, "ComponentAbsorbed").withArgs(
        setToken.address,
        setup.weth.address,
        airdroppedTokens,
        expectedManagerTake,
        expectedProtocolTake
      );
    });


    describe("when protocolFee is 0 but airdropFee > 0", async () => {
      before(async () => {
        protocolFee = ZERO;
      });

      after(async () => {
        protocolFee = ether(.15);
      });

      it("should create the correct new usdc position", async () => {
        const totalSupply = await setToken.totalSupply();
        const preDropBalance = ZERO;
        const balance = await setup.usdc.balanceOf(setToken.address);

        await subject();

        const airdroppedTokens = balance.sub(preDropBalance);
        const netBalance = balance.sub(preciseMul(airdroppedTokens, airdropFee));

        const positions = await setToken.getPositions();
        expect(positions[1].unit).to.eq(preciseDiv(netBalance, totalSupply));
      });

      it("should transfer the correct usdc amount to the setToken feeRecipient", async () => {
        const preDropBalance = ZERO;
        const balance = await setup.usdc.balanceOf(setToken.address);

        await subject();

        const airdroppedTokens = balance.sub(preDropBalance);
        const expectedManagerTake = preciseMul(preciseMul(airdroppedTokens, airdropFee), PRECISE_UNIT.sub(protocolFee));

        const actualManagerTake = await setup.usdc.balanceOf(feeRecipient.address);
        expect(actualManagerTake).to.eq(expectedManagerTake);
      });

      it("should transfer nothing to the protocol feeRecipient", async () => {
        const preDropBalance = ZERO;

        await subject();

        const actualProtocolTake = await setup.usdc.balanceOf(setup.feeRecipient);
        expect(actualProtocolTake).to.eq(preDropBalance);
      });

      it("should create the correct new eth position", async () => {
        const totalSupply = await setToken.totalSupply();
        const prePositions = await setToken.getPositions();
        const preDropBalance = preciseMul(prePositions[0].unit, totalSupply);
        const balance = await setup.weth.balanceOf(setToken.address);

        await subject();

        const airdroppedTokens = balance.sub(preDropBalance);
        const netBalance = balance.sub(preciseMul(airdroppedTokens, airdropFee));

        const positions = await setToken.getPositions();
        expect(positions[0].unit).to.eq(preciseDiv(netBalance, totalSupply));
      });

      it("should transfer the correct weth amount to the setToken feeRecipient", async () => {
        const totalSupply = await setToken.totalSupply();
        const prePositions = await setToken.getPositions();
        const preDropBalance = preciseMul(prePositions[0].unit, totalSupply);
        const balance = await setup.weth.balanceOf(setToken.address);

        await subject();

        const airdroppedTokens = balance.sub(preDropBalance);
        const expectedManagerTake = preciseMul(preciseMul(airdroppedTokens, airdropFee), PRECISE_UNIT.sub(protocolFee));

        const actualManagerTake = await setup.weth.balanceOf(feeRecipient.address);
        expect(actualManagerTake).to.eq(expectedManagerTake);
      });

      it("should transfer nothing to the protocol feeRecipient", async () => {
        const preDropBalance = await setup.weth.balanceOf(feeRecipient.address);

        await subject();

        const actualProtocolTake = await setup.weth.balanceOf(setup.feeRecipient);
        expect(actualProtocolTake).to.eq(preDropBalance);
      });
    });

    describe("when airdropFee is 0", async () => {
      before(async () => {
        airdropFee = ZERO;
      });

      after(async () => {
        airdropFee = ether(.15);
      });

      it("should create the correct new usdc position", async () => {
        const totalSupply = await setToken.totalSupply();
        const preDropBalance = ZERO;
        const balance = await setup.usdc.balanceOf(setToken.address);

        await subject();

        const airdroppedTokens = balance.sub(preDropBalance);
        const netBalance = balance.sub(preciseMul(airdroppedTokens, airdropFee));

        const positions = await setToken.getPositions();
        expect(positions[1].unit).to.eq(preciseDiv(netBalance, totalSupply));
      });

      it("should transfer nothing to the SetToken feeRecipient", async () => {
        const preDropBalance = ZERO;

        await subject();

        const actualProtocolTake = await setup.usdc.balanceOf(setup.feeRecipient);
        expect(actualProtocolTake).to.eq(preDropBalance);
      });

      it("should transfer nothing to the protocol feeRecipient", async () => {
        const preDropBalance = ZERO;

        await subject();

        const actualProtocolTake = await setup.usdc.balanceOf(setup.feeRecipient);
        expect(actualProtocolTake).to.eq(preDropBalance);
      });

      it("should create the correct new eth position", async () => {
        const totalSupply = await setToken.totalSupply();
        const prePositions = await setToken.getPositions();
        const preDropBalance = preciseMul(prePositions[0].unit, totalSupply);
        const balance = await setup.weth.balanceOf(setToken.address);

        await subject();

        const airdroppedTokens = balance.sub(preDropBalance);
        const netBalance = balance.sub(preciseMul(airdroppedTokens, airdropFee));

        const positions = await setToken.getPositions();
        expect(positions[0].unit).to.eq(preciseDiv(netBalance, totalSupply));
      });

      it("should transfer nothing to the setToken feeRecipient", async () => {
        const preDropBalance = await setup.weth.balanceOf(feeRecipient.address);

        await subject();

        const actualProtocolTake = await setup.weth.balanceOf(setup.feeRecipient);
        expect(actualProtocolTake).to.eq(preDropBalance);
      });

      it("should transfer nothing to the protocol feeRecipient", async () => {
        const preDropBalance = await setup.weth.balanceOf(feeRecipient.address);

        await subject();

        const actualProtocolTake = await setup.weth.balanceOf(setup.feeRecipient);
        expect(actualProtocolTake).to.eq(preDropBalance);
      });
    });

    describe("when anyoneAbsorb is false and the caller is the SetToken manager", async () => {
      before(async () => {
        anyoneAbsorb = false;
      });

      beforeEach(async () => {
        subjectCaller = owner;
      });

      after(async () => {
        anyoneAbsorb = true;
      });

      it("should create the correct new usdc position", async () => {
        const totalSupply = await setToken.totalSupply();
        const preDropBalance = ZERO;
        const balance = await setup.usdc.balanceOf(setToken.address);

        await subject();

        const airdroppedTokens = balance.sub(preDropBalance);
        const netBalance = balance.sub(preciseMul(airdroppedTokens, airdropFee));

        const positions = await setToken.getPositions();
        expect(positions[1].unit).to.eq(preciseDiv(netBalance, totalSupply));
      });

      it("should create the correct new eth position", async () => {
        const totalSupply = await setToken.totalSupply();
        const prePositions = await setToken.getPositions();
        const preDropBalance = preciseMul(prePositions[0].unit, totalSupply);
        const balance = await setup.weth.balanceOf(setToken.address);

        await subject();

        const airdroppedTokens = balance.sub(preDropBalance);
        const netBalance = balance.sub(preciseMul(airdroppedTokens, airdropFee));

        const positions = await setToken.getPositions();
        expect(positions[0].unit).to.eq(preciseDiv(netBalance, totalSupply));
      });
    });

    describe("when a passed token is not enabled by the manager", async () => {
      beforeEach(async () => {
        subjectTokens = [setup.usdc.address, setup.wbtc.address];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be approved token.");
      });
    });

    describe("when anyoneAbsorb is false and the caller is not the SetToken manager", async () => {
      before(async () => {
        anyoneAbsorb = false;
      });

      after(async () => {
        anyoneAbsorb = true;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid caller");
      });
    });

    describe("when module is not initialized", async () => {
      before(async () => {
        isInitialized = false;
      });

      beforeEach(async () => {
        subjectCaller = owner;
      });

      after(async () => {
        isInitialized = true;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });

    describe("when SetToken is not valid", async () => {
      beforeEach(async () => {
        const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
          [setup.weth.address],
          [ether(1)],
          [airdropModule.address]
        );

        subjectSetToken = nonEnabledSetToken.address;
        subjectCaller = owner;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#absorb", async () => {
    let airdrops: Address[];
    let airdropFee: BigNumber;
    let anyoneAbsorb: boolean;

    let airdropAmounts: BigNumber[];
    let protocolFee: BigNumber;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectToken: Address;
    let subjectCaller: Account;

    before(async () => {
      airdrops = [setup.usdc.address, setup.weth.address];
      airdropFee = ether(.2);
      anyoneAbsorb = true;

      protocolFee = ether(.15);
      airdropAmounts = [BigNumber.from(10 ** 10), ether(2)];
      isInitialized = true;
    });

    beforeEach(async () => {
      await setup.controller.addFee(airdropModule.address, ZERO, protocolFee);
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [airdropModule.address, setup.issuanceModule.address]
      );

      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      if (isInitialized) {
        const airdropSettings = {
          airdrops,
          feeRecipient: feeRecipient.address,
          airdropFee,
          anyoneAbsorb,
        };
        await airdropModule.connect(owner.wallet).initialize(setToken.address, airdropSettings);
      }

      await setup.issuanceModule.issue(setToken.address, ether(1.124), owner.address);

      await setup.usdc.transfer(setToken.address, airdropAmounts[0]);
      await setup.weth.transfer(setToken.address, airdropAmounts[1]);

      subjectSetToken = setToken.address;
      subjectToken = setup.usdc.address;
      subjectCaller = tokenHolder;
    });

    async function subject(): Promise<ContractTransaction> {
      return airdropModule.connect(subjectCaller.wallet).absorb(subjectSetToken, subjectToken);
    }

    it("should create the correct new usdc position", async () => {
      const totalSupply = await setToken.totalSupply();
      const preDropBalance = ZERO;
      const balance = await setup.usdc.balanceOf(setToken.address);

      await subject();

      const airdroppedTokens = balance.sub(preDropBalance);
      const netBalance = balance.sub(preciseMul(airdroppedTokens, airdropFee));

      const positions = await setToken.getPositions();
      expect(positions[1].unit).to.eq(preciseDiv(netBalance, totalSupply));
    });

    it("should transfer the correct usdc amount to the setToken feeRecipient", async () => {
      const preDropBalance = ZERO;
      const balance = await setup.usdc.balanceOf(setToken.address);

      await subject();

      const airdroppedTokens = balance.sub(preDropBalance);
      const expectedManagerTake = preciseMul(preciseMul(airdroppedTokens, airdropFee), PRECISE_UNIT.sub(protocolFee));

      const actualManagerTake = await setup.usdc.balanceOf(feeRecipient.address);
      expect(actualManagerTake).to.eq(expectedManagerTake);
    });

    it("should transfer the correct usdc amount to the protocol feeRecipient", async () => {
      const preDropBalance = ZERO;
      const balance = await setup.usdc.balanceOf(setToken.address);

      await subject();

      const airdroppedTokens = balance.sub(preDropBalance);
      const expectedProtocolTake = preciseMul(preciseMul(airdroppedTokens, airdropFee), protocolFee);
      const actualProtocolTake = await setup.usdc.balanceOf(setup.feeRecipient);
      expect(actualProtocolTake).to.eq(expectedProtocolTake);
    });

    it("should emit the correct ComponentAbsorbed event for USDC", async () => {
      const preDropBalance = ZERO;
      const balance = await setup.usdc.balanceOf(setToken.address);

      const airdroppedTokens = balance.sub(preDropBalance);
      const expectedManagerTake = preciseMul(preciseMul(airdroppedTokens, airdropFee), PRECISE_UNIT.sub(protocolFee));
      const expectedProtocolTake = preciseMul(preciseMul(airdroppedTokens, airdropFee), protocolFee);
      await expect(subject()).to.emit(airdropModule, "ComponentAbsorbed").withArgs(
        setToken.address,
        setup.usdc.address,
        airdroppedTokens,
        expectedManagerTake,
        expectedProtocolTake
      );
    });

    describe("when protocolFee is 0 but airdropFee > 0", async () => {
      before(async () => {
        protocolFee = ZERO;
      });

      after(async () => {
        protocolFee = ether(.15);
      });

      it("should create the correct new usdc position", async () => {
        const totalSupply = await setToken.totalSupply();
        const preDropBalance = ZERO;
        const balance = await setup.usdc.balanceOf(setToken.address);

        await subject();

        const airdroppedTokens = balance.sub(preDropBalance);
        const netBalance = balance.sub(preciseMul(airdroppedTokens, airdropFee));

        const positions = await setToken.getPositions();
        expect(positions[1].unit).to.eq(preciseDiv(netBalance, totalSupply));
      });

      it("should transfer the correct usdc amount to the setToken feeRecipient", async () => {
        const preDropBalance = ZERO;
        const balance = await setup.usdc.balanceOf(setToken.address);

        await subject();

        const airdroppedTokens = balance.sub(preDropBalance);
        const expectedManagerTake = preciseMul(preciseMul(airdroppedTokens, airdropFee), PRECISE_UNIT.sub(protocolFee));

        const actualManagerTake = await setup.usdc.balanceOf(feeRecipient.address);
        expect(actualManagerTake).to.eq(expectedManagerTake);
      });

      it("should transfer nothing to the protocol feeRecipient", async () => {
        const preDropBalance = ZERO;

        await subject();

        const actualProtocolTake = await setup.usdc.balanceOf(setup.feeRecipient);
        expect(actualProtocolTake).to.eq(preDropBalance);
      });
    });

    describe("when airdropFee is 0", async () => {
      before(async () => {
        airdropFee = ZERO;
      });

      after(async () => {
        airdropFee = ether(.15);
      });

      it("should create the correct new usdc position", async () => {
        const totalSupply = await setToken.totalSupply();
        const preDropBalance = ZERO;
        const balance = await setup.usdc.balanceOf(setToken.address);

        await subject();

        const airdroppedTokens = balance.sub(preDropBalance);
        const netBalance = balance.sub(preciseMul(airdroppedTokens, airdropFee));

        const positions = await setToken.getPositions();
        expect(positions[1].unit).to.eq(preciseDiv(netBalance, totalSupply));
      });

      it("should transfer nothing to the setToken feeRecipient", async () => {
        const preDropBalance = ZERO;

        await subject();

        const actualProtocolTake = await setup.usdc.balanceOf(setup.feeRecipient);
        expect(actualProtocolTake).to.eq(preDropBalance);
      });

      it("should transfer nothing to the protocol feeRecipient", async () => {
        const preDropBalance = ZERO;

        await subject();

        const actualProtocolTake = await setup.usdc.balanceOf(setup.feeRecipient);
        expect(actualProtocolTake).to.eq(preDropBalance);
      });
    });

    describe("when anyoneAbsorb is false and the caller is the SetToken manager", async () => {
      before(async () => {
        anyoneAbsorb = false;
      });

      beforeEach(async () => {
        subjectCaller = owner;
      });

      after(async () => {
        anyoneAbsorb = true;
      });

      it("should create the correct new usdc position", async () => {
        const totalSupply = await setToken.totalSupply();
        const preDropBalance = ZERO;
        const balance = await setup.usdc.balanceOf(setToken.address);

        await subject();

        const airdroppedTokens = balance.sub(preDropBalance);
        const netBalance = balance.sub(preciseMul(airdroppedTokens, airdropFee));

        const positions = await setToken.getPositions();
        expect(positions[1].unit).to.eq(preciseDiv(netBalance, totalSupply));
      });
    });

    describe("when anyoneAbsorb is false and the caller is not the SetToken manager", async () => {
      before(async () => {
        anyoneAbsorb = false;
      });

      after(async () => {
        anyoneAbsorb = true;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid caller");
      });
    });

    describe("when passed token is not an approved airdrop", async () => {
      beforeEach(async () => {
        subjectToken = setup.wbtc.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be approved token.");
      });
    });

    describe("when module is not initialized", async () => {
      before(async () => {
        isInitialized = false;
      });

      beforeEach(async () => {
        subjectCaller = owner;
      });

      after(async () => {
        isInitialized = true;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });

    describe("when SetToken is not valid", async () => {
      beforeEach(async () => {
        const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
          [setup.weth.address],
          [ether(1)],
          [airdropModule.address]
        );

        subjectSetToken = nonEnabledSetToken.address;
        subjectCaller = owner;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#removeModule", async () => {
    let setToken: SetToken;

    let subjectModule: Address;

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [airdropModule.address]
      );

      const airdrops = [setup.usdc.address, setup.weth.address];
      const airdropFee = ether(.2);
      const anyoneAbsorb = true;
      const airdropSettings = {
        airdrops,
        feeRecipient: feeRecipient.address,
        airdropFee,
        anyoneAbsorb,
      };
      await airdropModule.connect(owner.wallet).initialize(setToken.address, airdropSettings);
      subjectModule = airdropModule.address;
    });

    async function subject(): Promise<any> {
      return setToken.removeModule(subjectModule);
    }

    it("should delete the airdropSettings", async () => {
      await subject();
      const airdropSettings: any = await airdropModule.airdropSettings(setToken.address);
      const airdrops = await airdropModule.getAirdrops(setToken.address);

      expect(airdrops).to.be.empty;
      expect(airdropSettings.airdropFee).to.eq(ZERO);
      expect(airdropSettings.anyoneAbsorb).to.be.false;
    });

    it("should reset the isAirdrop mapping", async () => {
      await subject();

      const wethIsAirdrop = await airdropModule.isAirdrop(subjectModule, setup.weth.address);
      const usdcIsAirdrop = await airdropModule.isAirdrop(subjectModule, setup.usdc.address);

      expect(wethIsAirdrop).to.be.false;
      expect(usdcIsAirdrop).to.be.false;
    });
  });

  describe("CONTEXT: Airdrop add/remove", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectAirdrop: Address;
    let subjectCaller: Account;

    before(async () => {
      isInitialized = true;
    });

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [airdropModule.address]
      );

      const airdrops = [setup.usdc.address, setup.weth.address];
      const airdropFee = ether(.2);
      const anyoneAbsorb = true;

      if (isInitialized) {
        const airdropSettings = {
          airdrops,
          feeRecipient: feeRecipient.address,
          airdropFee,
          anyoneAbsorb,
        };
        await airdropModule.connect(owner.wallet).initialize(setToken.address, airdropSettings);
      }
    });

    describe("#addAirdrop", async () => {
      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectAirdrop = setup.wbtc.address;
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        airdropModule = airdropModule.connect(subjectCaller.wallet);
        return airdropModule.addAirdrop(subjectSetToken, subjectAirdrop);
      }

      it("should add the new token", async () => {
        await subject();

        const airdrops = await airdropModule.getAirdrops(setToken.address);
        const isAirdrop = await airdropModule.isAirdrop(subjectSetToken, subjectAirdrop);
        expect(airdrops[2]).to.eq(subjectAirdrop);
        expect(isAirdrop).to.be.true;
      });

      it("should emit the correct AirdropComponentAdded event", async () => {
        await expect(subject()).to.emit(airdropModule, "AirdropComponentAdded").withArgs(
          subjectSetToken,
          subjectAirdrop
        );
      });

      describe("when airdrop has already been added", async () => {
        beforeEach(async () => {
          subjectAirdrop = setup.usdc.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Token already added.");
        });
      });

      describe("when module is not initialized", async () => {
        before(async () => {
          isInitialized = false;
        });

        after(async () => {
          isInitialized = true;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });

      describe("when SetToken is not valid", async () => {
        beforeEach(async () => {
          const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
            [setup.weth.address],
            [ether(1)],
            [airdropModule.address]
          );

          subjectSetToken = nonEnabledSetToken.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });
    });

    describe("#removeAirdrop", async () => {
      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectAirdrop = setup.usdc.address;
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        airdropModule = airdropModule.connect(subjectCaller.wallet);
        return airdropModule.removeAirdrop(subjectSetToken, subjectAirdrop);
      }

      it("should remove the token", async () => {
        await subject();

        const airdrops = await airdropModule.getAirdrops(setToken.address);
        const isAirdrop = await airdropModule.isAirdrop(subjectSetToken, subjectAirdrop);
        expect(airdrops).to.not.contain(subjectAirdrop);
        expect(isAirdrop).to.be.false;
      });

      it("should emit the correct AirdropComponentRemoved event", async () => {
        await expect(subject()).to.emit(airdropModule, "AirdropComponentRemoved").withArgs(
          subjectSetToken,
          subjectAirdrop
        );
      });

      describe("when airdrop is not in the airdrops array", async () => {
        beforeEach(async () => {
          subjectAirdrop = setup.wbtc.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Token not added.");
        });
      });

      describe("when module is not initialized", async () => {
        before(async () => {
          isInitialized = false;
        });

        after(async () => {
          isInitialized = true;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });

      describe("when SetToken is not valid", async () => {
        beforeEach(async () => {
          const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
            [setup.weth.address],
            [ether(1)],
            [airdropModule.address]
          );

          subjectSetToken = nonEnabledSetToken.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });
    });
  });

  describe("#updateAirdropFee", async () => {
    let airdrops: Address[];
    let airdropFee: BigNumber;
    let anyoneAbsorb: boolean;

    let airdropAmounts: BigNumber[];
    let protocolFee: BigNumber;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectNewFee: BigNumber;
    let subjectCaller: Account;

    before(async () => {
      airdrops = [setup.usdc.address, setup.weth.address];
      airdropFee = ether(.2);
      anyoneAbsorb = true;

      protocolFee = ether(.15);
      airdropAmounts = [BigNumber.from(10 ** 10), ether(2)];
      isInitialized = true;
    });

    beforeEach(async () => {
      await setup.controller.addFee(airdropModule.address, ZERO, protocolFee);
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [airdropModule.address, setup.issuanceModule.address]
      );

      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      if (isInitialized) {
        const airdropSettings = {
          airdrops,
          feeRecipient: feeRecipient.address,
          airdropFee,
          anyoneAbsorb,
        };
        await airdropModule.connect(owner.wallet).initialize(setToken.address, airdropSettings);
      }

      await setup.issuanceModule.issue(setToken.address, ether(1.124), owner.address);

      await setup.usdc.transfer(setToken.address, airdropAmounts[0]);

      subjectSetToken = setToken.address;
      subjectNewFee = ether(.5);
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return airdropModule.connect(subjectCaller.wallet).updateAirdropFee(subjectSetToken, subjectNewFee);
    }

    it("should create the correct new usdc position", async () => {
      const totalSupply = await setToken.totalSupply();
      const preDropBalance = ZERO;
      const balance = await setup.usdc.balanceOf(setToken.address);

      await subject();

      const airdroppedTokens = balance.sub(preDropBalance);
      const netBalance = balance.sub(preciseMul(airdroppedTokens, airdropFee));

      const positions = await setToken.getPositions();
      expect(positions[1].unit).to.eq(preciseDiv(netBalance, totalSupply));
    });

    it("should set the new fee", async () => {
      await subject();

      const airdropSettings = await airdropModule.airdropSettings(setToken.address);
      expect(airdropSettings.airdropFee).to.eq(subjectNewFee);
    });

    it("should emit the correct AirdropFeeUpdated event", async () => {
      await expect(subject()).to.emit(airdropModule, "AirdropFeeUpdated").withArgs(
        subjectSetToken,
        subjectNewFee
      );
    });

    describe("when new fee exceeds 100%", async () => {
      beforeEach(async () => {
        subjectNewFee = ether(1.1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Airdrop fee can't exceed 100%");
      });
    });

    describe("when module is not initialized", async () => {
      before(async () => {
        isInitialized = false;
      });

      after(async () => {
        isInitialized = true;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });

    describe("when SetToken is not valid", async () => {
      beforeEach(async () => {
        const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
          [setup.weth.address],
          [ether(1)],
          [airdropModule.address]
        );

        subjectSetToken = nonEnabledSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#updateAnyoneAbsorb", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectAnyoneAbsorb: boolean;
    let subjectCaller: Account;

    before(async () => {
      isInitialized = true;
    });

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [airdropModule.address]
      );

      const airdrops = [setup.usdc.address, setup.weth.address];
      const airdropFee = ether(.2);
      const anyoneAbsorb = false;

      if (isInitialized) {
        const airdropSettings = {
          airdrops,
          feeRecipient: feeRecipient.address,
          airdropFee,
          anyoneAbsorb,
        };
        await airdropModule.connect(owner.wallet).initialize(setToken.address, airdropSettings);
      }

      subjectSetToken = setToken.address;
      subjectAnyoneAbsorb = true;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      airdropModule = airdropModule.connect(subjectCaller.wallet);
      return airdropModule.updateAnyoneAbsorb(subjectSetToken, subjectAnyoneAbsorb);
    }

    it("should flip the anyoneAbsorb indicator", async () => {
      await subject();

      const airdropSettings = await airdropModule.airdropSettings(setToken.address);
      expect(airdropSettings.anyoneAbsorb).to.be.true;
    });

    it("should emit the correct AnyoneAbsorbUpdated event", async () => {
      await expect(subject()).to.emit(airdropModule, "AnyoneAbsorbUpdated").withArgs(
        subjectSetToken,
        subjectAnyoneAbsorb
      );
    });

    describe("when module is not initialized", async () => {
      before(async () => {
        isInitialized = false;
      });

      after(async () => {
        isInitialized = true;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });

    describe("when SetToken is not valid", async () => {
      beforeEach(async () => {
        const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
          [setup.weth.address],
          [ether(1)],
          [airdropModule.address]
        );

        subjectSetToken = nonEnabledSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#updateFeeRecipient", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectNewFeeRecipient: Address;
    let subjectCaller: Account;

    before(async () => {
      isInitialized = true;
    });

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [airdropModule.address]
      );

      const airdrops = [setup.usdc.address, setup.weth.address];
      const airdropFee = ether(.2);
      const anyoneAbsorb = true;

      if (isInitialized) {
        const airdropSettings = {
          airdrops,
          feeRecipient: feeRecipient.address,
          airdropFee,
          anyoneAbsorb,
        };
        await airdropModule.connect(owner.wallet).initialize(setToken.address, airdropSettings);
      }

      subjectSetToken = setToken.address;
      subjectNewFeeRecipient = await getRandomAddress();
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      airdropModule = airdropModule.connect(subjectCaller.wallet);
      return airdropModule.updateFeeRecipient(subjectSetToken, subjectNewFeeRecipient);
    }

    it("should change the fee recipient to the new address", async () => {
      await subject();

      const airdropSettings = await airdropModule.airdropSettings(setToken.address);
      expect(airdropSettings.feeRecipient).to.eq(subjectNewFeeRecipient);
    });

    it("should emit the correct FeeRecipientUpdated event", async () => {
      await expect(subject()).to.emit(airdropModule, "FeeRecipientUpdated").withArgs(
        subjectSetToken,
        subjectNewFeeRecipient
      );
    });

    describe("when passed address is zero", async () => {
      beforeEach(async () => {
        subjectNewFeeRecipient = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Passed address must be non-zero");
      });
    });

    describe("when module is not initialized", async () => {
      before(async () => {
        isInitialized = false;
      });

      after(async () => {
        isInitialized = true;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });

    describe("when SetToken is not valid", async () => {
      beforeEach(async () => {
        const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
          [setup.weth.address],
          [ether(1)],
          [airdropModule.address]
        );

        subjectSetToken = nonEnabledSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#getAirdrops", async () => {
    let setToken: SetToken;
    let airdrops: Address[];

    let subjectSetToken: Address;

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [airdropModule.address]
      );

      airdrops = [setup.usdc.address, setup.weth.address];
      const airdropFee = ether(.2);
      const anyoneAbsorb = true;
      const airdropSettings = {
        airdrops,
        feeRecipient: feeRecipient.address,
        airdropFee,
        anyoneAbsorb,
      };
      await airdropModule.connect(owner.wallet).initialize(setToken.address, airdropSettings);
      subjectSetToken = setToken.address;
    });

    async function subject(): Promise<any> {
      return airdropModule.getAirdrops(subjectSetToken);
    }

    it("should return the airdops array", async () => {
      const actualAirdrops = await subject();

      expect(JSON.stringify(actualAirdrops)).to.eq(JSON.stringify(airdrops));
    });
  });

  describe("#isAirdrop", async () => {
    let subjectSetToken: Address;
    let subjectToken: Address;

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [airdropModule.address]
      );

      const airdrops = [setup.usdc.address, setup.weth.address];
      const airdropFee = ether(.2);
      const anyoneAbsorb = true;
      const airdropSettings = {
        airdrops,
        feeRecipient: feeRecipient.address,
        airdropFee,
        anyoneAbsorb,
      };
      await airdropModule.connect(owner.wallet).initialize(setToken.address, airdropSettings);

      subjectSetToken = setToken.address;
      subjectToken = setup.usdc.address;
    });

    async function subject(): Promise<any> {
      return airdropModule.isAirdropToken(subjectSetToken, subjectToken);
    }

    it("should return true", async () => {
      const isAirdrop = await subject();

      expect(isAirdrop).to.be.true;
    });

    describe("when token not included in airdrops array", async () => {
      beforeEach(async () => {
        subjectToken = setup.wbtc.address;
      });

      it("should return true", async () => {
        const isAirdrop = await subject();

        expect(isAirdrop).to.be.false;
      });
    });
  });
});
