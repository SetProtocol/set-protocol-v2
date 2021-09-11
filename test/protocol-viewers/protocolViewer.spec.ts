import "module-alias/register";
import { BigNumber } from "ethers";

import { Address, StreamingFeeState } from "@utils/types";
import { Account } from "@utils/test/types";
import { ADDRESS_ZERO, ZERO, ONE, TWO, ONE_YEAR_IN_SECONDS } from "@utils/constants";
import { ProtocolViewer, SetToken } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  ether,
  getStreamingFee,
} from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  getLastBlockTimestamp,
  increaseTimeAsync
} from "@utils/test/index";
import { SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("ProtocolViewer", () => {
  let owner: Account;
  let dummyModule: Account;
  let pendingModule: Account;
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
      pendingModule,
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
      managerOne.address,
      "FirstSetToken",
      "ONE"
    );

    setTokenTwo = await setup.createSetToken(
      [setup.wbtc.address],
      [ether(1)],
      [setup.issuanceModule.address, setup.streamingFeeModule.address],
      managerTwo.address,
      "SecondSetToken",
      "TWO"
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

      const setOneExpectedStates = [BigNumber.from(2), BigNumber.from(2), ONE];
      const setTwoExpectedStates = [ONE, BigNumber.from(2), ZERO];

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

  describe("#getSetDetails", async () => {
    let subjectSetToken: Address;
    let subjectModules: Address[];

    beforeEach(async () => {
      await setup.controller.addModule(pendingModule.address);
      await setTokenTwo.connect(managerTwo.wallet).addModule(pendingModule.address);

      subjectSetToken = setTokenTwo.address;
      subjectModules = [
        dummyModule.address,
        setup.streamingFeeModule.address,
        setup.issuanceModule.address,
        pendingModule.address,
      ];
    });

    async function subject(): Promise<any> {
      return viewer.getSetDetails(subjectSetToken, subjectModules);
    }

    it("should return the correct set details", async () => {
      const details: any = await subject();

      const name = await setTokenTwo.name();
      expect(details.name).to.eq(name);

      const symbol = await setTokenTwo.symbol();
      expect(details.symbol).to.eq(symbol);

      const manager = await setTokenTwo.manager();
      expect(details.manager).to.eq(manager);

      const modules = await setTokenTwo.getModules();
      expect(JSON.stringify(details.modules)).to.eq(JSON.stringify(modules));

      const expectedStatuses = [ZERO.toNumber(), TWO.toNumber(), ONE.toNumber(), ONE.toNumber()];
      expect(JSON.stringify(details.moduleStatuses)).to.eq(JSON.stringify(expectedStatuses));

      const positions = await setTokenTwo.getPositions();
      expect(JSON.stringify(details.positions)).to.eq(JSON.stringify(positions));

      const totalSupply = await setTokenTwo.totalSupply();
      expect(details.totalSupply).to.eq(totalSupply);
    });
  });

  describe("#batchFetchDetails", async () => {
    let subjectSetTokenAddresses: Address[];
    let subjectModules: Address[];

    beforeEach(async () => {
      await setup.controller.addModule(pendingModule.address);
      await setTokenOne.connect(managerOne.wallet).addModule(pendingModule.address);
      await setTokenTwo.connect(managerTwo.wallet).addModule(pendingModule.address);

      subjectSetTokenAddresses = [setTokenOne.address, setTokenTwo.address];
      subjectModules = [
        dummyModule.address,
        setup.streamingFeeModule.address,
        setup.issuanceModule.address,
        pendingModule.address,
      ];
    });

    async function subject(): Promise<any> {
      return viewer.batchFetchDetails(subjectSetTokenAddresses, subjectModules);
    }

    it("should return the correct set details", async () => {
      const [setOneDetails, setTwoDetails]: any = await subject();

      const setOneName = await setTokenOne.name();
      const setTwoName = await setTokenTwo.name();
      expect(setOneDetails.name).to.eq(setOneName);
      expect(setTwoDetails.name).to.eq(setTwoName);

      const setOneSymbol = await setTokenOne.symbol();
      const setTwoSymbol = await setTokenTwo.symbol();
      expect(setOneDetails.symbol).to.eq(setOneSymbol);
      expect(setTwoDetails.symbol).to.eq(setTwoSymbol);

      const setOneManager = await setTokenOne.manager();
      const setTwoManager = await setTokenTwo.manager();
      expect(setOneDetails.manager).to.eq(setOneManager);
      expect(setTwoDetails.manager).to.eq(setTwoManager);

      const setOneModules = await setTokenOne.getModules();
      const setTwoModules = await setTokenTwo.getModules();
      expect(JSON.stringify(setOneDetails.modules)).to.eq(JSON.stringify(setOneModules));
      expect(JSON.stringify(setTwoDetails.modules)).to.eq(JSON.stringify(setTwoModules));

      const expectedTokenOneStatuses = [ONE.toNumber(), TWO.toNumber(), TWO.toNumber(), ONE.toNumber()];
      const expectTokenTwoStatuses = [ZERO.toNumber(), TWO.toNumber(), ONE.toNumber(), ONE.toNumber()];
      expect(JSON.stringify(setOneDetails.moduleStatuses)).to.eq(JSON.stringify(expectedTokenOneStatuses));
      expect(JSON.stringify(setTwoDetails.moduleStatuses)).to.eq(JSON.stringify(expectTokenTwoStatuses));

      const setOnePositions = await setTokenOne.getPositions();
      const setTwoPositions = await setTokenTwo.getPositions();
      expect(JSON.stringify(setOneDetails.positions)).to.eq(JSON.stringify(setOnePositions));
      expect(JSON.stringify(setTwoDetails.positions)).to.eq(JSON.stringify(setTwoPositions));

      const setOneTotalSupply = await setTokenOne.totalSupply();
      const setTwoTotalSupply = await setTokenTwo.totalSupply();
      expect(setOneDetails.totalSupply).to.eq(setOneTotalSupply);
      expect(setTwoDetails.totalSupply).to.eq(setTwoTotalSupply);
    });
  });

  describe("#batchFetchBalancesOf", async () => {
    let subjectTokenAddresses: Address[];
    let subjectOwnerAddresses: Address[];

    beforeEach(async () => {
      subjectTokenAddresses = [setup.usdc.address, setup.dai.address];
      subjectOwnerAddresses = [owner.address, managerOne.address];
    });

    async function subject(): Promise<any> {
      return viewer.batchFetchBalancesOf(subjectTokenAddresses, subjectOwnerAddresses);
    }

    it("should return the correct set details", async () => {
      const [balanceOne, balanceTwo]: any = await subject();

      const expectedUSDCBalance = await setup.usdc.connect(owner.wallet).balanceOf(owner.address);
      expect(balanceOne).to.eq(expectedUSDCBalance);

      const expectedDAIBalance = await setup.dai.connect(owner.wallet).balanceOf(managerOne.address);
      expect(balanceTwo).to.eq(expectedDAIBalance);
    });
  });

  describe("#batchFetchAllowances", async () => {
    let subjectTokenAddresses: Address[];
    let subjectOwnerAddresses: Address[];
    let subjectSpenderAddresses: Address[];

    beforeEach(async () => {
      const usdcApprovalAmount = ether(3);
      await setup.usdc.approve(managerOne.address, usdcApprovalAmount);

      const daiApprovalAmount = ether(2);
      await setup.dai.approve(managerTwo.address, daiApprovalAmount);

      subjectTokenAddresses = [setup.usdc.address, setup.dai.address];
      subjectOwnerAddresses = [owner.address, owner.address];
      subjectSpenderAddresses = [managerOne.address, managerTwo.address];
    });

    async function subject(): Promise<any> {
      return viewer.batchFetchAllowances(
        subjectTokenAddresses,
        subjectOwnerAddresses,
        subjectSpenderAddresses
      );
    }

    it("should return the correct allowances", async () => {
      const [allowanceOne, allowanceTwo]: any = await subject();

      const expectedUSDCAllowance = await setup.usdc.allowance(
        owner.address,
        managerOne.address
      );
      expect(allowanceOne).to.eq(expectedUSDCAllowance);

      const expectedDAIAllowance = await setup.dai.allowance(
        owner.address,
        managerTwo.address
      );
      expect(allowanceTwo).to.eq(expectedDAIAllowance);
    });
  });
});
