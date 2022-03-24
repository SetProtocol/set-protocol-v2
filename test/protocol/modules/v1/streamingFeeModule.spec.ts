import "module-alias/register";

import { BigNumber } from "ethers";

import { Address, ContractTransaction, StreamingFeeState } from "@utils/types";
import { Account } from "@utils/test/types";
import { ONE_YEAR_IN_SECONDS, ZERO, ADDRESS_ZERO, PRECISE_UNIT } from "@utils/constants";
import { BasicIssuanceModule, StreamingFeeModule, SetToken } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
  getPostFeePositionUnits,
  getStreamingFee,
  getStreamingFeeInflationAmount,
  preciseMul,
} from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getRandomAddress,
  getRandomAccount,
  getWaffleExpect,
  getSystemFixture,
  increaseTimeAsync,
  getLastBlockTimestamp,
  getTransactionTimestamp,
} from "@utils/test/index";
import { SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("StreamingFeeModule", () => {
  let owner: Account;
  let feeRecipient: Account;
  let deployer: DeployHelper;

  let setup: SystemFixture;
  let streamingFeeModule: StreamingFeeModule;
  let issuanceModule: BasicIssuanceModule;

  before(async () => {
    [
      owner,
      feeRecipient,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    issuanceModule = await deployer.modules.deployBasicIssuanceModule(setup.controller.address);
    await setup.controller.addModule(issuanceModule.address);

    streamingFeeModule = await deployer.modules.deployStreamingFeeModule(setup.controller.address);
    await setup.controller.addModule(streamingFeeModule.address);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#initialize", async () => {
    let setToken: SetToken;
    let feeRecipient: Address;
    let maxStreamingFeePercentage: BigNumber;
    let streamingFeePercentage: BigNumber;

    let subjectSetToken: Address;
    let subjectSettings: StreamingFeeState;
    let subjectCaller: Account;

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [streamingFeeModule.address]
      );

      feeRecipient = await getRandomAddress();
      maxStreamingFeePercentage = ether(.1);
      streamingFeePercentage = ether(.02);

      subjectSetToken = setToken.address;
      subjectSettings = {
        feeRecipient,
        maxStreamingFeePercentage,
        streamingFeePercentage,
        lastStreamingFeeTimestamp: ZERO,
      } as StreamingFeeState;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      streamingFeeModule = streamingFeeModule.connect(subjectCaller.wallet);
      return streamingFeeModule.initialize(subjectSetToken, subjectSettings);
    }

    it("should enable the Module on the SetToken", async () => {
      await subject();
      const isModuleEnabled = await setToken.isInitializedModule(streamingFeeModule.address);
      expect(isModuleEnabled).to.eq(true);
    });

    it("should set all the fields in FeeState correctly", async () => {
      const txTimestamp = await getTransactionTimestamp(subject());

      const feeState: StreamingFeeState = await streamingFeeModule.feeStates(setToken.address);

      expect(feeState.feeRecipient).to.eq(subjectSettings.feeRecipient);
      expect(feeState.maxStreamingFeePercentage).to.eq(subjectSettings.maxStreamingFeePercentage);
      expect(feeState.streamingFeePercentage).to.eq(subjectSettings.streamingFeePercentage);
      expect(feeState.lastStreamingFeeTimestamp).to.eq(txTimestamp);
    });

    describe("when the caller is not the SetToken manager", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
      });
    });

    describe("when module is in NONE state", async () => {
      beforeEach(async () => {
        await subject();
        await setToken.removeModule(streamingFeeModule.address);
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
          [streamingFeeModule.address]
        );

        subjectSetToken = nonEnabledSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be controller-enabled SetToken");
      });
    });

    describe("when passed max fee is greater than 100%", async () => {
      beforeEach(async () => {
        subjectSettings.maxStreamingFeePercentage = ether(1.1);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Max fee must be < 100%.");
      });
    });

    describe("when passed fee is greater than max fee", async () => {
      beforeEach(async () => {
        subjectSettings.streamingFeePercentage = ether(.11);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Fee must be <= max.");
      });
    });

    describe("when feeRecipient is zero address", async () => {
      beforeEach(async () => {
        subjectSettings.feeRecipient = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Fee Recipient must be non-zero address.");
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
        [streamingFeeModule.address]
      );

      const feeRecipient = await getRandomAddress();
      const streamingFeePercentage = ether(.02);
      const maxStreamingFeePercentage = ether(.1);

      const settings = {
        feeRecipient,
        maxStreamingFeePercentage,
        streamingFeePercentage,
        lastStreamingFeeTimestamp: ZERO,
      } as StreamingFeeState;
      await streamingFeeModule.initialize(setToken.address, settings);

      subjectModule = streamingFeeModule.address;
    });

    async function subject(): Promise<any> {
      return setToken.removeModule(subjectModule);
    }

    it("should delete the feeState", async () => {
      await subject();
      const feeState: StreamingFeeState = await streamingFeeModule.feeStates(setToken.address);
      expect(feeState.feeRecipient).to.eq(ADDRESS_ZERO);
      expect(feeState.maxStreamingFeePercentage).to.eq(ZERO);
      expect(feeState.streamingFeePercentage).to.eq(ZERO);
      expect(feeState.lastStreamingFeeTimestamp).to.eq(ZERO);
    });
  });

  describe("#getFee", async () => {
    let setToken: SetToken;
    let settings: StreamingFeeState;

    let subjectSetToken: Address;
    let subjectTimeFastForward: BigNumber;

    before(async () => {
      settings = {
        feeRecipient: feeRecipient.address,
        maxStreamingFeePercentage: ether(.1),
        streamingFeePercentage: ether(.02),
        lastStreamingFeeTimestamp: ZERO,
      } as StreamingFeeState;
    });

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [streamingFeeModule.address]
      );

      await streamingFeeModule.initialize(setToken.address, settings);

      subjectSetToken = setToken.address;
      subjectTimeFastForward = ONE_YEAR_IN_SECONDS;
    });

    async function subject(): Promise<BigNumber> {
      await increaseTimeAsync(subjectTimeFastForward);
      return streamingFeeModule.getFee(subjectSetToken);
    }

    it("return the correct fee inflation percentage", async () => {
      const feeState = await streamingFeeModule.feeStates(subjectSetToken);

      const feeInflation = await subject();
      const callTimestamp = await getLastBlockTimestamp();

      const expectedFeePercent = await getStreamingFee(
        streamingFeeModule,
        subjectSetToken,
        feeState.lastStreamingFeeTimestamp,
        callTimestamp
      );

      expect(feeInflation).to.eq(expectedFeePercent);
    });
  });

  describe("#accrueFee", async () => {
    let setToken: SetToken;
    let settings: StreamingFeeState;
    let isInitialized: boolean;
    let protocolFee: BigNumber;

    let subjectSetToken: Address;
    let subjectTimeFastForward: BigNumber;

    before(async () => {
      settings = {
        feeRecipient: feeRecipient.address,
        maxStreamingFeePercentage: ether(.1),
        streamingFeePercentage: ether(.02),
        lastStreamingFeeTimestamp: ZERO,
      } as StreamingFeeState;
      isInitialized = true;
    });

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(.01)],
        [issuanceModule.address, streamingFeeModule.address]
      );

      if (isInitialized) {
        await streamingFeeModule.initialize(setToken.address, settings);
      }

      await issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      await setup.weth.approve(issuanceModule.address, ether(1));
      await issuanceModule.connect(owner.wallet).issue(setToken.address, ether(1), owner.address);

      protocolFee = ether(.15);
      await setup.controller.addFee(streamingFeeModule.address, ZERO, protocolFee);

      subjectSetToken = setToken.address;
      subjectTimeFastForward = ONE_YEAR_IN_SECONDS;
    });

    async function subject(): Promise<ContractTransaction> {
      await increaseTimeAsync(subjectTimeFastForward);
      return streamingFeeModule.accrueFee(subjectSetToken);
    }

    it("mints the correct amount of new Sets to the feeRecipient", async () => {
      const feeState = await streamingFeeModule.feeStates(subjectSetToken);
      const totalSupply = await setToken.totalSupply();

      const txnTimestamp = await getTransactionTimestamp(subject());

      const expectedFeeInflation = await getStreamingFee(
        streamingFeeModule,
        subjectSetToken,
        feeState.lastStreamingFeeTimestamp,
        txnTimestamp
      );

      const feeInflation = getStreamingFeeInflationAmount(expectedFeeInflation, totalSupply);
      const protocolFeeAmount = preciseMul(feeInflation, protocolFee);
      const feeRecipientBalance = await setToken.balanceOf(feeState.feeRecipient);

      expect(feeRecipientBalance).to.eq(feeInflation.sub(protocolFeeAmount));
    });

    it("mints the correct amount of new Sets to the protocol feeRecipient", async () => {
      const feeState = await streamingFeeModule.feeStates(subjectSetToken);
      const totalSupply = await setToken.totalSupply();

      const txnTimestamp = await getTransactionTimestamp(subject());

      const expectedFeeInflation = await getStreamingFee(
        streamingFeeModule,
        subjectSetToken,
        feeState.lastStreamingFeeTimestamp,
        txnTimestamp
      );
      const feeInflation = getStreamingFeeInflationAmount(expectedFeeInflation, totalSupply);

      const feeRecipientBalance = await setToken.balanceOf(setup.feeRecipient);
      expect(feeRecipientBalance).to.eq(preciseMul(feeInflation, protocolFee));
    });

    it("emits the correct FeeActualized event", async () => {
      const feeState = await streamingFeeModule.feeStates(subjectSetToken);
      const totalSupply = await setToken.totalSupply();

      const subjectPromise = subject();
      const txnTimestamp = await getTransactionTimestamp(subjectPromise);

      const expectedFeeInflation = await getStreamingFee(
        streamingFeeModule,
        subjectSetToken,
        feeState.lastStreamingFeeTimestamp,
        txnTimestamp
      );

      const feeInflation = getStreamingFeeInflationAmount(expectedFeeInflation, totalSupply);
      const protocolFeeAmount = preciseMul(feeInflation, protocolFee);

      await expect(subjectPromise).to.emit(streamingFeeModule, "FeeActualized").withArgs(
        setToken.address,
        feeInflation.sub(protocolFeeAmount),
        protocolFeeAmount
      );
    });

    it("update totalSupply correctly", async () => {
      const feeState = await streamingFeeModule.feeStates(subjectSetToken);
      const previousTotalSupply = await setToken.totalSupply();

      const txnTimestamp = await getTransactionTimestamp(subject());

      const expectedFeeInflation = await getStreamingFee(
        streamingFeeModule,
        subjectSetToken,
        feeState.lastStreamingFeeTimestamp,
        txnTimestamp
      );
      const feeInflation = getStreamingFeeInflationAmount(expectedFeeInflation, previousTotalSupply);
      const newTotalSupply = await setToken.totalSupply();

      expect(newTotalSupply).to.eq(previousTotalSupply.add(feeInflation));
    });

    it("sets a new lastStreamingFeeTimestamp", async () => {
      const txnTimestamp = await getTransactionTimestamp(subject());

      const feeState: any = await streamingFeeModule.feeStates(subjectSetToken);

      expect(feeState.lastStreamingFeeTimestamp).to.eq(txnTimestamp);
    });

    it("updates positionMultiplier correctly", async () => {
      const feeState = await streamingFeeModule.feeStates(subjectSetToken);

      const txnTimestamp = await getTransactionTimestamp(subject());

      const expectedFeeInflation = await getStreamingFee(
        streamingFeeModule,
        subjectSetToken,
        feeState.lastStreamingFeeTimestamp,
        txnTimestamp
      );
      const expectedNewMultiplier = preciseMul(PRECISE_UNIT, PRECISE_UNIT.sub(expectedFeeInflation));
      const newMultiplier = await setToken.positionMultiplier();

      expect(newMultiplier).to.eq(expectedNewMultiplier);
    });

    it("updates position units correctly", async () => {
      const feeState = await streamingFeeModule.feeStates(subjectSetToken);
      const oldPositions = await setToken.getPositions();

      const txnTimestamp = await getTransactionTimestamp(subject());

      const expectedFeeInflation = await getStreamingFee(
        streamingFeeModule,
        subjectSetToken,
        feeState.lastStreamingFeeTimestamp,
        txnTimestamp
      );
      const expectedNewUnits = getPostFeePositionUnits([oldPositions[0].unit], expectedFeeInflation);
      const newPositions = await setToken.getPositions();

      expect(newPositions[0].unit).to.eq(expectedNewUnits[0]);
    });

    describe("when a position is negative", async () => {
      beforeEach(async () => {
        await setup.controller.addModule(owner.address);
        await setToken.addModule(owner.address);
        await setToken.initializeModule();

        await setToken.addComponent(setup.usdc.address);
        await setToken.addExternalPositionModule(setup.usdc.address, owner.address);
        await setToken.editExternalPositionUnit(setup.usdc.address, owner.address, ether(.01).mul(-1));
      });

      it("updates positionMultiplier correctly", async () => {
        const feeState = await streamingFeeModule.feeStates(subjectSetToken);

        const txnTimestamp = await getTransactionTimestamp(subject());

        const expectedFeeInflation = await getStreamingFee(
          streamingFeeModule,
          subjectSetToken,
          feeState.lastStreamingFeeTimestamp,
          txnTimestamp
        );
        const expectedNewMultiplier = preciseMul(PRECISE_UNIT, PRECISE_UNIT.sub(expectedFeeInflation));
        const newMultiplier = await setToken.positionMultiplier();

        expect(newMultiplier).to.eq(expectedNewMultiplier);
      });

      it("update position units correctly", async () => {
        const feeState = await streamingFeeModule.feeStates(subjectSetToken);
        const oldPositions = await setToken.getPositions();

        const txnTimestamp = await getTransactionTimestamp(subject());

        const expectedFeeInflation = await getStreamingFee(
          streamingFeeModule,
          subjectSetToken,
          feeState.lastStreamingFeeTimestamp,
          txnTimestamp
        );
        const expectedNewUnits = getPostFeePositionUnits(
          [oldPositions[0].unit, oldPositions[1].unit],
          expectedFeeInflation
        );
        const newPositions = await setToken.getPositions();

        expect(newPositions[0].unit).to.eq(expectedNewUnits[0]);
        expect(newPositions[1].unit).to.eq(expectedNewUnits[1]);
      });
    });

    describe("when protocolFee is 0", async () => {
      beforeEach(async () => {
        await setup.controller.editFee(streamingFeeModule.address, ZERO, ZERO);
      });

      it("mints the correct amount of new Sets to the feeRecipient", async () => {
        const feeState = await streamingFeeModule.feeStates(subjectSetToken);
        const totalSupply = await setToken.totalSupply();

        const txnTimestamp = await getTransactionTimestamp(subject());

        const expectedFeeInflation = await getStreamingFee(
          streamingFeeModule,
          subjectSetToken,
          feeState.lastStreamingFeeTimestamp,
          txnTimestamp
        );

        const feeInflation = getStreamingFeeInflationAmount(expectedFeeInflation, totalSupply);
        const feeRecipientBalance = await setToken.balanceOf(feeState.feeRecipient);

        expect(feeRecipientBalance).to.eq(feeInflation);
      });

      it("mints no Sets to the protocol feeRecipient", async () => {
        await subject();

        const feeRecipientBalance = await setToken.balanceOf(setup.feeRecipient);
        expect(feeRecipientBalance).to.eq(ZERO);
      });
    });

    describe("when streamingFee is 0", async () => {
      beforeEach(async () => {
        await streamingFeeModule.updateStreamingFee(subjectSetToken, ZERO);
      });

      it("should update the last timestamp", async () => {
        const txnTimestamp = await getTransactionTimestamp(subject());

        const feeState: any = await streamingFeeModule.feeStates(subjectSetToken);

        expect(feeState.lastStreamingFeeTimestamp).to.eq(txnTimestamp);
      });

      it("emits the correct FeeActualized event", async () => {
        const subjectPromise = subject();

        await expect(subjectPromise).to.emit(streamingFeeModule, "FeeActualized").withArgs(
          setToken.address,
          ZERO,
          ZERO
        );
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
          [streamingFeeModule.address]
        );

        subjectSetToken = nonEnabledSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#updateStreamingFee", async () => {
    let setToken: SetToken;
    let settings: StreamingFeeState;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectNewFee: BigNumber;
    let subjectTimeFastForward: BigNumber;
    let subjectCaller: Account;

    before(async () => {
      settings = {
        feeRecipient: feeRecipient.address,
        maxStreamingFeePercentage: ether(.1),
        streamingFeePercentage: ether(.02),
        lastStreamingFeeTimestamp: ZERO,
      } as StreamingFeeState;
      isInitialized = true;
    });

    after(async () => {
      streamingFeeModule = streamingFeeModule.connect(owner.wallet);
    });

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(.01)],
        [issuanceModule.address, streamingFeeModule.address]
      );

      if (isInitialized) {
        await streamingFeeModule.initialize(setToken.address, settings);
      }
      await issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

      await setup.weth.approve(issuanceModule.address, ether(1));
      await issuanceModule.issue(setToken.address, ether(1), owner.address);

      subjectSetToken = setToken.address;
      subjectNewFee = ether(.03);
      subjectTimeFastForward = ONE_YEAR_IN_SECONDS;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      await increaseTimeAsync(subjectTimeFastForward);
      streamingFeeModule = streamingFeeModule.connect(subjectCaller.wallet);
      return streamingFeeModule.updateStreamingFee(subjectSetToken, subjectNewFee);
    }

    it("sets the new fee percentage", async () => {
      await subject();

      const feeState: any = await streamingFeeModule.feeStates(subjectSetToken);

      expect(feeState.streamingFeePercentage).to.eq(subjectNewFee);
    });

    it("accrues fees to the feeRecipient at old fee rate", async () => {
      const feeState = await streamingFeeModule.feeStates(subjectSetToken);
      const totalSupply = await setToken.totalSupply();

      const txnTimestamp = await getTransactionTimestamp(subject());

      const expectedFeeInflation = await getStreamingFee(
        streamingFeeModule,
        subjectSetToken,
        feeState.lastStreamingFeeTimestamp,
        txnTimestamp,
        feeState.streamingFeePercentage
      );

      const feeInflation = getStreamingFeeInflationAmount(expectedFeeInflation, totalSupply);
      const feeRecipientBalance = await setToken.balanceOf(feeState.feeRecipient);

      expect(feeRecipientBalance).to.eq(feeInflation);
    });

    it("emits the StreamingFeeUpdated event", async () => {
      await expect(subject()).to.emit(streamingFeeModule, "StreamingFeeUpdated").withArgs(
        subjectSetToken,
        subjectNewFee,
      );
    });

    describe("when the streaming fee is initially 0", async () => {
      before(async () => {
        settings.streamingFeePercentage = ZERO;
      });

      after(async () => {
        settings.streamingFeePercentage = ether(.02);
      });

      it("sets the new fee percentage", async () => {
        await subject();

        const feeState: any = await streamingFeeModule.feeStates(subjectSetToken);

        expect(feeState.streamingFeePercentage).to.eq(subjectNewFee);
      });
    });

    describe("when SetToken is not valid", async () => {
      beforeEach(async () => {
        const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
          [setup.weth.address],
          [ether(1)],
          [streamingFeeModule.address]
        );

        subjectSetToken = nonEnabledSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });

    describe("when passed fee is greater than max fee", async () => {
      beforeEach(async () => {
        subjectNewFee = ether(.11);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Fee must be less than max");
      });
    });

    describe("when the caller is not the SetToken manager", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
      });
    });

    describe("when the existing fee is 0", async () => {
      before(async () => {
        isInitialized = false;
      });

      after(async () => {
        isInitialized = true;
      });
    });
  });

  describe("#updateFeeRecipient", async () => {
    let setToken: SetToken;
    let settings: StreamingFeeState;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectNewFeeRecipient: Address;
    let subjectCaller: Account;

    before(async () => {
      settings = {
        feeRecipient: feeRecipient.address,
        maxStreamingFeePercentage: ether(.1),
        streamingFeePercentage: ether(.02),
        lastStreamingFeeTimestamp: ZERO,
      } as StreamingFeeState;
      isInitialized = true;
    });

    after(async () => {
      streamingFeeModule = streamingFeeModule.connect(owner.wallet);
    });

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(.01)],
        [issuanceModule.address, streamingFeeModule.address]
      );

      if (isInitialized) {
        await streamingFeeModule.initialize(setToken.address, settings);
      }

      subjectSetToken = setToken.address;
      subjectNewFeeRecipient = owner.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      streamingFeeModule = streamingFeeModule.connect(subjectCaller.wallet);
      return streamingFeeModule.updateFeeRecipient(subjectSetToken, subjectNewFeeRecipient);
    }

    it("sets the fee recipient", async () => {
      await subject();

      const feeState: any = await streamingFeeModule.feeStates(subjectSetToken);

      expect(feeState.feeRecipient).to.eq(subjectNewFeeRecipient);
    });

    it("emits the FeeRecipientUpdated event", async () => {
      await expect(subject()).to.emit(streamingFeeModule, "FeeRecipientUpdated").withArgs(
        subjectSetToken,
        subjectNewFeeRecipient,
      );
    });

    describe("when feeRecipient is zero address", async () => {
      beforeEach(async () => {
        subjectNewFeeRecipient = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Fee Recipient must be non-zero address.");
      });
    });

    describe("when the caller is not the SetToken manager", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
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
          [streamingFeeModule.address]
        );

        subjectSetToken = nonEnabledSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });
});
