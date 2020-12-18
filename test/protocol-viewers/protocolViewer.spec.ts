import "module-alias/register";
import { BigNumber } from "ethers/utils";

import { Address, Account, StreamingFeeState } from "@utils/types";
import { ADDRESS_ZERO, ZERO, ONE, ONE_YEAR_IN_SECONDS } from "@utils/constants";
import { ProtocolViewer, SetToken } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getWaffleExpect,
  getStreamingFee,
  getSystemFixture,
  getLastBlockTimestamp,
  increaseTimeAsync
} from "@utils/index";
import { SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("ProtocolViewer", () => {
  let owner: Account;
  let dummyModule: Account;
  let managerOne: Account;
  let managerTwo: Account;

  let deployer: DeployHelper;
  let setup: SystemFixture;

  let viewer: ProtocolViewer;

  let setTokenOne: SetToken;
  let setTokenTwo: SetToken;

  before(async () => {
    [
      owner,
      dummyModule,
      managerOne,
      managerTwo,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();
    await setup.controller.addModule(dummyModule.address);

    viewer = await deployer.viewers.deployProtocolViewer();

    setTokenOne = await setup.createSetToken(
      [setup.weth.address],
      [ether(1)],
      [setup.issuanceModule.address, setup.streamingFeeModule.address, dummyModule.address],
      managerOne.address
    );

    setTokenTwo = await setup.createSetToken(
      [setup.wbtc.address],
      [ether(1)],
      [setup.issuanceModule.address, setup.streamingFeeModule.address],
      managerTwo.address
    );

    const streamingFeeStateOne = {
      feeRecipient: managerOne.address,
      maxStreamingFeePercentage: ether(.1),
      streamingFeePercentage: ether(.02),
      lastStreamingFeeTimestamp: ZERO,
    } as StreamingFeeState;
    const streamingFeeStateTwo = {
      feeRecipient: managerTwo.address,
      maxStreamingFeePercentage: ether(.1),
      streamingFeePercentage: ether(.04),
      lastStreamingFeeTimestamp: ZERO,
    } as StreamingFeeState;
    await setup.streamingFeeModule.connect(managerOne.wallet).initialize(setTokenOne.address, streamingFeeStateOne);
    await setup.streamingFeeModule.connect(managerTwo.wallet).initialize(setTokenTwo.address, streamingFeeStateTwo);

    await setup.issuanceModule.connect(managerOne.wallet).initialize(setTokenOne.address, ADDRESS_ZERO);
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#batchFetchModuleStates", async () => {
    let subjectSetTokens: Address[];
    let subjectModules: Address[];

    beforeEach(async () => {
      subjectSetTokens = [setTokenOne.address, setTokenTwo.address];
      subjectModules = [setup.issuanceModule.address, setup.streamingFeeModule.address, dummyModule.address];
    });

    async function subject(): Promise<any> {
      return viewer.batchFetchModuleStates(subjectSetTokens, subjectModules);
    }

    it("should return the correct module states", async () => {
      const [setOneStates, setTwoStates] = await subject();

      const setOneExpectedStates = [new BigNumber(2), new BigNumber(2), ONE];
      const setTwoExpectedStates = [ONE, new BigNumber(2), ZERO];

      expect(setOneStates[0]).to.eq(setOneExpectedStates[0]);
      expect(setOneStates[1]).to.eq(setOneExpectedStates[1]);
      expect(setOneStates[2]).to.eq(setOneExpectedStates[2]);
      expect(setTwoStates[0]).to.eq(setTwoExpectedStates[0]);
      expect(setTwoStates[1]).to.eq(setTwoExpectedStates[1]);
      expect(setTwoStates[2]).to.eq(setTwoExpectedStates[2]);
    });
  });

  describe("#batchFetchManagers", async () => {
    let subjectSetTokens: Address[];

    beforeEach(async () => {
      subjectSetTokens = [setTokenOne.address, setTokenTwo.address];
    });

    async function subject(): Promise<any> {
      return viewer.batchFetchManagers(subjectSetTokens);
    }

    it("should return the correct managers", async () => {
      const managers = await subject();

      expect(managers[0]).to.eq(managerOne.address);
      expect(managers[1]).to.eq(managerTwo.address);
    });
  });

  describe("#batchFetchStreamingFeeInfo", async () => {
    let subjectStreamingFeeModule: Address;
    let subjectSetTokens: Address[];

    let subjectTimeFastForward: BigNumber;

    beforeEach(async () => {
      subjectStreamingFeeModule = setup.streamingFeeModule.address;
      subjectSetTokens = [setTokenOne.address, setTokenTwo.address];
      subjectTimeFastForward = ONE_YEAR_IN_SECONDS;
    });

    async function subject(): Promise<any> {
      await increaseTimeAsync(subjectTimeFastForward);
      return viewer.batchFetchStreamingFeeInfo(subjectStreamingFeeModule, subjectSetTokens);
    }

    it("should return the correct streaming fee info", async () => {
      const feeStateOne = await setup.streamingFeeModule.feeStates(subjectSetTokens[0]);
      const feeStateTwo = await setup.streamingFeeModule.feeStates(subjectSetTokens[1]);

      const [setOneFeeInfo, setTwoFeeInfo] = await subject();

      const callTimestamp = await getLastBlockTimestamp();

      const expectedFeePercentOne = await getStreamingFee(
        setup.streamingFeeModule,
        subjectSetTokens[0],
        feeStateOne.lastStreamingFeeTimestamp,
        callTimestamp
      );
      const expectedFeePercentTwo = await getStreamingFee(
        setup.streamingFeeModule,
        subjectSetTokens[1],
        feeStateTwo.lastStreamingFeeTimestamp,
        callTimestamp
      );

      expect(setOneFeeInfo.feeRecipient).to.eq(managerOne.address);
      expect(setTwoFeeInfo.feeRecipient).to.eq(managerTwo.address);
      expect(setOneFeeInfo.streamingFeePercentage).to.eq(ether(.02));
      expect(setTwoFeeInfo.streamingFeePercentage).to.eq(ether(.04));
      expect(setOneFeeInfo.unaccruedFees).to.eq(expectedFeePercentOne);
      expect(setTwoFeeInfo.unaccruedFees).to.eq(expectedFeePercentTwo);
    });
  });
});
