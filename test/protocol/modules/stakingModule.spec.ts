import "module-alias/register";
import { BigNumber } from "@ethersproject/bignumber";

import { Address, Account } from "@utils/types";
import { ADDRESS_ZERO, ZERO, EMPTY_BYTES } from "@utils/constants";
import { SetToken, StakingAdapterMock, StakingModule } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  ether,
  getAccounts,
  getRandomAccount,
  getSystemFixture,
  getWaffleExpect,
  hashAdapterName,
  preciseMul
} from "@utils/index";
import { SystemFixture } from "@utils/fixtures";
import { ContractTransaction } from "ethers";
import { HashZero } from "@ethersproject/constants";

const expect = getWaffleExpect();

describe("StakingModule", () => {
  let owner: Account;
  let dummyIssuanceModule: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;

  let setToken: SetToken;
  let wethStake: StakingAdapterMock;
  let wethTwoStake: StakingAdapterMock;
  let stakingModule: StakingModule;

  const wethStakeName: string = "StandardWethStaker";
  const wethTwoStakeName: string = "SuperWethStaker";

  before(async () => {
    [
      owner,
      dummyIssuanceModule,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    stakingModule = await deployer.modules.deployStakingModule(setup.controller.address);
    await setup.controller.addModule(stakingModule.address);
    await setup.controller.addModule(dummyIssuanceModule.address);

    wethStake = await deployer.mocks.deployStakingAdapterMock(setup.weth.address);
    wethTwoStake = await deployer.mocks.deployStakingAdapterMock(setup.weth.address);
    await setup.integrationRegistry.batchAddIntegration(
      [stakingModule.address, stakingModule.address],
      [wethStakeName, wethTwoStakeName],
      [wethStake.address, wethTwoStake.address]
    );

    setToken = await setup.createSetToken(
      [setup.weth.address, setup.wbtc.address],
      [ether(1), BigNumber.from(10 ** 8)],
      [setup.issuanceModule.address, stakingModule.address, dummyIssuanceModule.address]
    );
    await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
    await setToken.connect(dummyIssuanceModule.wallet).initializeModule();
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#initialize", async () => {
    let setToken: SetToken;

    let subjectSetToken: Address;
    let subjectCaller: Account;

    beforeEach(async () => {
      setToken = await setup.createSetToken([setup.wbtc.address], [ether(1)], [stakingModule.address]);
      subjectSetToken = setToken.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return stakingModule.connect(subjectCaller.wallet).initialize(subjectSetToken);
    }

    it("should enable the Module on the SetToken", async () => {
      await subject();
      const isModuleEnabled = await setToken.isInitializedModule(stakingModule.address);
      expect(isModuleEnabled).to.eq(true);
    });

    describe("when the caller is not the SetToken manager", async () => {
      beforeEach(async () => {
        subjectCaller = await getRandomAccount();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
      });
    });

    describe("when the module is not pending", async () => {
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
          [setup.dai.address],
          [ether(1)],
          [stakingModule.address],
        );

        subjectSetToken = nonEnabledSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be controller-enabled SetToken");
      });
    });
  });

  describe("#removeModule", async () => {
    let subjectModule: Address;

    beforeEach(async () => {
      subjectModule = stakingModule.address;

      const issuedSupply = ether(2);
      await setup.issuanceModule.issue(setToken.address, issuedSupply, owner.address);

      await stakingModule.initialize(setToken.address);
    });

    async function subject(): Promise<ContractTransaction> {
      return setToken.removeModule(subjectModule);
    }

    it("should remove the module from the SetToken", async () => {
      await subject();

      const modules = await setToken.getModules();
      expect(modules).to.not.contain(subjectModule);
    });

    describe("when the there is an open external position", async () => {
      beforeEach(async () => {
        await stakingModule.stake(
          setToken.address,
          wethStake.address,
          setup.weth.address,
          wethStakeName,
          ether(.5)
        );
      });

      it("should transfer the staked tokens to the staking contract", async () => {
        await expect(subject()).to.be.revertedWith("Open positions must be closed");
      });
    });
  });

  describe("#stake", async () => {
    let issuedSupply: BigNumber;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectStakeContract: Address;
    let subjectComponent: Address;
    let subjectAdapter: Address;
    let subjectComponentPositionUnits: BigNumber;
    let subjectCaller: Account;

    before(async () => {
      isInitialized = true;
    });

    beforeEach(async () => {
      if (isInitialized) {
        await stakingModule.initialize(setToken.address);
      }

      issuedSupply = ether(2);
      await setup.issuanceModule.issue(setToken.address, issuedSupply, owner.address);

      subjectSetToken = setToken.address;
      subjectStakeContract = wethStake.address;
      subjectComponent = setup.weth.address;
      subjectAdapter = wethStakeName;
      subjectComponentPositionUnits = ether(.5);
      subjectCaller = owner;
    });

    async function subject(): Promise<ContractTransaction> {
      return stakingModule.connect(subjectCaller.wallet).stake(
        subjectSetToken,
        subjectStakeContract,
        subjectComponent,
        subjectAdapter,
        subjectComponentPositionUnits
      );
    }

    it("should transfer the staked tokens to the staking contract", async () => {
      const preTokenBalance = await setup.weth.balanceOf(subjectStakeContract);

      await subject();

      const postTokenBalance = await setup.weth.balanceOf(subjectStakeContract);
      const expectedTokensStaked = preciseMul(issuedSupply, subjectComponentPositionUnits);
      expect(postTokenBalance).to.eq(preTokenBalance.add(expectedTokensStaked));
    });

    it("should update the Default units on the SetToken correctly", async () => {
      const prePositionUnit = await setToken.getDefaultPositionRealUnit(subjectComponent);

      await subject();

      const postPositionUnit = await setToken.getDefaultPositionRealUnit(subjectComponent);
      expect(postPositionUnit).to.eq(prePositionUnit.sub(subjectComponentPositionUnits));
    });

    it("should update the External units and state on the SetToken correctly", async () => {
      const prePositionUnit = await setToken.getExternalPositionRealUnit(subjectComponent, stakingModule.address);

      await subject();

      const postPositionUnit = await setToken.getExternalPositionRealUnit(subjectComponent, stakingModule.address);
      const externalModules = await setToken.getExternalPositionModules(subjectComponent);
      const data = await setToken.getExternalPositionData(subjectComponent, stakingModule.address);

      expect(postPositionUnit).to.eq(prePositionUnit.add(subjectComponentPositionUnits));
      expect(externalModules[0]).to.eq(stakingModule.address);
      expect(externalModules.length).to.eq(1);
      expect(data).to.eq(EMPTY_BYTES);
    });

    it("should create the correct ComponentPosition struct on the StakingModule", async () => {
      await subject();

      const stakingContracts = await stakingModule.getStakingContracts(subjectSetToken, subjectComponent);
      const position: any = await stakingModule.getStakingPosition(subjectSetToken, subjectComponent, subjectStakeContract);

      expect(stakingContracts.length).to.eq(1);
      expect(stakingContracts[0]).to.eq(subjectStakeContract);
      expect(position.componentPositionUnits).to.eq(subjectComponentPositionUnits);
      expect(position.adapterHash).to.eq(hashAdapterName(wethStakeName));
    });

    it("should emit the correct ComponentStaked event", async () => {
      await expect(subject()).to.emit(stakingModule, "ComponentStaked").withArgs(
        subjectSetToken,
        subjectComponent,
        subjectStakeContract,
        subjectComponentPositionUnits,
        wethStake.address
      );
    });

    describe("when the position is being added to", async () => {
      beforeEach(async () => {
        await subject();
      });

      it("should transfer the staked tokens to the staking contract", async () => {
        const preTokenBalance = await setup.weth.balanceOf(subjectStakeContract);

        await subject();

        const postTokenBalance = await setup.weth.balanceOf(subjectStakeContract);
        const expectedTokensStaked = preciseMul(issuedSupply, subjectComponentPositionUnits);
        expect(postTokenBalance).to.eq(preTokenBalance.add(expectedTokensStaked));
      });

      it("should update the Default units on the SetToken correctly", async () => {
        const prePositionUnit = await setToken.getDefaultPositionRealUnit(subjectComponent);

        await subject();

        const postPositionUnit = await setToken.getDefaultPositionRealUnit(subjectComponent);
        expect(postPositionUnit).to.eq(prePositionUnit.sub(subjectComponentPositionUnits));
      });

      it("should update the External units and state on the SetToken correctly", async () => {
        const prePositionUnit = await setToken.getExternalPositionRealUnit(subjectComponent, stakingModule.address);
        const preExternalModules = await setToken.getExternalPositionModules(subjectComponent);
        expect(preExternalModules[0]).to.eq(stakingModule.address);
        expect(preExternalModules.length).to.eq(1);

        await subject();

        const postPositionUnit = await setToken.getExternalPositionRealUnit(subjectComponent, stakingModule.address);
        const postExternalModules = await setToken.getExternalPositionModules(subjectComponent);

        expect(postPositionUnit).to.eq(prePositionUnit.add(subjectComponentPositionUnits));
        expect(postExternalModules[0]).to.eq(stakingModule.address);
        expect(postExternalModules.length).to.eq(1);
      });

      it("should create the correct ComponentPosition struct on the StakingModule", async () => {
        await subject();

        const stakingContracts = await stakingModule.getStakingContracts(subjectSetToken, subjectComponent);
        const position: any = await stakingModule.getStakingPosition(subjectSetToken, subjectComponent, subjectStakeContract);
        expect(stakingContracts.length).to.eq(1);
        expect(stakingContracts[0]).to.eq(subjectStakeContract);
        expect(position.componentPositionUnits).to.eq(subjectComponentPositionUnits.mul(2));
      });

      it("should emit the correct ComponentStaked event", async () => {
        await expect(subject()).to.emit(stakingModule, "ComponentStaked").withArgs(
          subjectSetToken,
          subjectComponent,
          subjectStakeContract,
          subjectComponentPositionUnits,
          wethStake.address
        );
      });
    });

    describe("when trying to stake more tokens than available in Default state", async () => {
      beforeEach(async () => {
        subjectComponentPositionUnits = ether(1.1);
      });

      it("should emit the correct ComponentStaked event", async () => {
        await expect(subject()).to.be.revertedWith("Not enough component to stake");
      });
    });

    describe("when passed adapter is not valid", async () => {
      beforeEach(async () => {
        subjectAdapter = "ThisIsWrong";
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid adapter");
      });
    });

    describe("when caller is not manager", async () => {
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
          [stakingModule.address]
        );

        subjectSetToken = nonEnabledSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#unstake", async () => {
    let issuedSupply: BigNumber;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectStakeContract: Address;
    let subjectComponent: Address;
    let subjectAdapter: Address;
    let subjectComponentPositionUnits: BigNumber;
    let subjectCaller: Account;

    before(async () => {
      isInitialized = true;
    });

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectStakeContract = wethStake.address;
      subjectComponent = setup.weth.address;
      subjectAdapter = wethStakeName;
      subjectComponentPositionUnits = ether(.5);
      subjectCaller = owner;

      issuedSupply = ether(2);
      await setup.issuanceModule.issue(setToken.address, issuedSupply, owner.address);

      if (isInitialized) {
        await stakingModule.initialize(setToken.address);
        await stakingModule.stake(
          subjectSetToken,
          subjectStakeContract,
          subjectComponent,
          subjectAdapter,
          ether(.5)
        );
      }
    });

    async function subject(): Promise<ContractTransaction> {
      return stakingModule.connect(subjectCaller.wallet).unstake(
        subjectSetToken,
        subjectStakeContract,
        subjectComponent,
        subjectAdapter,
        subjectComponentPositionUnits
      );
    }

    it("should transfer the staked tokens to the setToken", async () => {
      const preTokenBalance = await setup.weth.balanceOf(subjectSetToken);

      await subject();

      const postTokenBalance = await setup.weth.balanceOf(subjectSetToken);
      const expectedTokensStaked = preciseMul(issuedSupply, subjectComponentPositionUnits);
      expect(postTokenBalance).to.eq(preTokenBalance.add(expectedTokensStaked));
    });

    it("should update the Default units on the SetToken correctly", async () => {
      const prePositionUnit = await setToken.getDefaultPositionRealUnit(subjectComponent);

      await subject();

      const postPositionUnit = await setToken.getDefaultPositionRealUnit(subjectComponent);
      expect(postPositionUnit).to.eq(prePositionUnit.add(subjectComponentPositionUnits));
    });

    it("should update the External units and state on the SetToken correctly", async () => {
      const prePositionUnit = await setToken.getExternalPositionRealUnit(subjectComponent, stakingModule.address);
      const preExternalModules = await setToken.getExternalPositionModules(subjectComponent);
      expect(preExternalModules[0]).to.eq(stakingModule.address);
      expect(preExternalModules.length).to.eq(1);

      await subject();

      const postPositionUnit = await setToken.getExternalPositionRealUnit(subjectComponent, stakingModule.address);
      const postExternalModules = await setToken.getExternalPositionModules(subjectComponent);
      const data = await setToken.getExternalPositionData(subjectComponent, stakingModule.address);

      expect(postPositionUnit).to.eq(prePositionUnit.sub(subjectComponentPositionUnits));
      expect(postExternalModules.length).to.eq(0);
      expect(data).to.eq(EMPTY_BYTES);
    });

    it("should remove the stakingContract from the component's stakingContracts", async () => {
      const preStakingContracts = await stakingModule.getStakingContracts(subjectSetToken, subjectComponent);
      expect(preStakingContracts.length).to.eq(1);
      expect(preStakingContracts[0]).to.eq(subjectStakeContract);

      await subject();

      const postStakingContracts = await stakingModule.getStakingContracts(subjectSetToken, subjectComponent);
      expect(postStakingContracts.length).to.eq(0);
    });

    it("should delete the StakingPosition associated with the staking contract", async () => {
      await subject();

      const position: any = await stakingModule.getStakingPosition(subjectSetToken, subjectComponent, subjectStakeContract);
      expect(position.adapterHash).to.eq(HashZero);
      expect(position.componentPositionUnits).to.eq(ZERO);
    });

    it("should emit the correct ComponentUnstaked event", async () => {
      await expect(subject()).to.emit(stakingModule, "ComponentUnstaked").withArgs(
        subjectSetToken,
        subjectComponent,
        subjectStakeContract,
        subjectComponentPositionUnits,
        wethStake.address
      );
    });

    describe("when the full position is not being removed", async () => {
      beforeEach(async () => {
        subjectComponentPositionUnits = ether(.25);
      });

      it("should transfer the staked tokens to the SetToken", async () => {
        const preTokenBalance = await setup.weth.balanceOf(subjectSetToken);

        await subject();

        const postTokenBalance = await setup.weth.balanceOf(subjectSetToken);
        const expectedTokensStaked = preciseMul(issuedSupply, subjectComponentPositionUnits);
        expect(postTokenBalance).to.eq(preTokenBalance.add(expectedTokensStaked));
      });

      it("should update the Default units on the SetToken correctly", async () => {
        const prePositionUnit = await setToken.getDefaultPositionRealUnit(subjectComponent);

        await subject();

        const postPositionUnit = await setToken.getDefaultPositionRealUnit(subjectComponent);
        expect(postPositionUnit).to.eq(prePositionUnit.add(subjectComponentPositionUnits));
      });

      it("should update the External units and state on the SetToken correctly", async () => {
        const prePositionUnit = await setToken.getExternalPositionRealUnit(subjectComponent, stakingModule.address);
        const preExternalModules = await setToken.getExternalPositionModules(subjectComponent);
        expect(preExternalModules[0]).to.eq(stakingModule.address);
        expect(preExternalModules.length).to.eq(1);

        await subject();

        const postPositionUnit = await setToken.getExternalPositionRealUnit(subjectComponent, stakingModule.address);
        const postExternalModules = await setToken.getExternalPositionModules(subjectComponent);

        expect(postPositionUnit).to.eq(prePositionUnit.sub(subjectComponentPositionUnits));
        expect(postExternalModules[0]).to.eq(preExternalModules[0]);
        expect(postExternalModules.length).to.eq(1);
      });

      it("should update the ComponentPosition struct on the StakingModule", async () => {
        await subject();

        const stakingContracts = await stakingModule.getStakingContracts(subjectSetToken, subjectComponent);
        const position: any = await stakingModule.getStakingPosition(subjectSetToken, subjectComponent, subjectStakeContract);
        expect(stakingContracts.length).to.eq(1);
        expect(stakingContracts[0]).to.eq(subjectStakeContract);
        expect(position.componentPositionUnits).to.eq(ether(.5).sub(subjectComponentPositionUnits));
      });

      it("should emit the correct ComponentStaked event", async () => {
        await expect(subject()).to.emit(stakingModule, "ComponentUnstaked").withArgs(
          subjectSetToken,
          subjectComponent,
          subjectStakeContract,
          subjectComponentPositionUnits,
          wethStake.address
        );
      });
    });

    describe("when staking contract doesn't return the expected amount of tokens", async () => {
      beforeEach(async () => {
        await wethStake.setUnstakeFee(ether(.01));
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Not enough tokens returned from stake contract");
      });
    });

    describe("when trying to unstake more tokens than staked", async () => {
      beforeEach(async () => {
        subjectComponentPositionUnits = ether(.6);
      });

      it("should emit the correct ComponentStaked event", async () => {
        await expect(subject()).to.be.revertedWith("Not enough component tokens staked");
      });
    });

    describe("when passed adapter is not valid", async () => {
      beforeEach(async () => {
        subjectAdapter = "ThisIsWrong";
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid adapter");
      });
    });


    describe("when caller is not manager", async () => {
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
          [stakingModule.address]
        );

        subjectSetToken = nonEnabledSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#issueHook", async () => {
    let issuedSupply: BigNumber;
    let tokenTransferAmount: BigNumber;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectComponent: Address;
    let subjectSetTokenQuantity: BigNumber;
    let subjectCaller: Account;

    before(async () => {
      isInitialized = true;
      tokenTransferAmount = ether(.5);
    });

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectComponent = setup.weth.address;
      subjectSetTokenQuantity = ether(.5);
      subjectCaller = dummyIssuanceModule;

      issuedSupply = ether(2);
      await setup.issuanceModule.issue(setToken.address, issuedSupply, owner.address);

      if (isInitialized) {
        await stakingModule.initialize(setToken.address);
        await stakingModule.stake(
          subjectSetToken,
          wethStake.address,
          subjectComponent,
          wethStakeName,
          ether(.5)
        );
        await stakingModule.stake(
          subjectSetToken,
          wethTwoStake.address,
          subjectComponent,
          wethTwoStakeName,
          ether(.5)
        );
      }

      await setup.weth.transfer(setToken.address, tokenTransferAmount);
    });

    async function subject(): Promise<ContractTransaction> {
      return stakingModule.connect(subjectCaller.wallet).issueHook(
        subjectSetToken,
        subjectSetTokenQuantity,
        subjectComponent
      );
    }

    it("should transfer tokens from setToken to staking contract(s)", async () => {
      const preSetTokenBalance = await setup.weth.balanceOf(subjectSetToken);
      const preWethOneBalance = await setup.weth.balanceOf(wethStake.address);
      const preWethTwoBalance = await setup.weth.balanceOf(wethTwoStake.address);

      await subject();

      const postSetTokenBalance = await setup.weth.balanceOf(subjectSetToken);
      const postWethOneBalance = await setup.weth.balanceOf(wethStake.address);
      const postWethTwoBalance = await setup.weth.balanceOf(wethTwoStake.address);

      const expectedTokensTransferred = preciseMul(subjectSetTokenQuantity, ether(1));

      expect(postSetTokenBalance).to.eq(preSetTokenBalance.sub(expectedTokensTransferred));
      expect(postWethOneBalance).to.eq(preWethOneBalance.add(expectedTokensTransferred.div(2)));
      expect(postWethTwoBalance).to.eq(preWethTwoBalance.add(expectedTokensTransferred.div(2)));
    });

    describe("if non-module is caller", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Only the module can call");
      });
    });

    describe("if disabled module is caller", async () => {
      beforeEach(async () => {
        await setup.controller.removeModule(dummyIssuanceModule.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Module must be enabled on controller");
      });
    });
  });

  describe("#redeemHook", async () => {
    let issuedSupply: BigNumber;
    let tokenTransferAmount: BigNumber;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectComponent: Address;
    let subjectSetTokenQuantity: BigNumber;
    let subjectCaller: Account;

    before(async () => {
      isInitialized = true;
      tokenTransferAmount = ether(.5);
    });

    beforeEach(async () => {
      subjectSetToken = setToken.address;
      subjectComponent = setup.weth.address;
      subjectSetTokenQuantity = ether(.5);
      subjectCaller = dummyIssuanceModule;

      issuedSupply = ether(2);
      await setup.issuanceModule.issue(setToken.address, issuedSupply, owner.address);

      if (isInitialized) {
        await stakingModule.initialize(setToken.address);
        await stakingModule.stake(
          subjectSetToken,
          wethStake.address,
          subjectComponent,
          wethStakeName,
          ether(.5)
        );
        await stakingModule.stake(
          subjectSetToken,
          wethTwoStake.address,
          subjectComponent,
          wethTwoStakeName,
          ether(.5)
        );
      }

      await setup.weth.transfer(setToken.address, tokenTransferAmount);
    });

    async function subject(): Promise<ContractTransaction> {
      return stakingModule.connect(subjectCaller.wallet).redeemHook(
        subjectSetToken,
        subjectSetTokenQuantity,
        subjectComponent
      );
    }

    it("should transfer tokens from staking contract(s) to setToken", async () => {
      const preSetTokenBalance = await setup.weth.balanceOf(subjectSetToken);
      const preWethOneBalance = await setup.weth.balanceOf(wethStake.address);
      const preWethTwoBalance = await setup.weth.balanceOf(wethTwoStake.address);

      await subject();

      const postSetTokenBalance = await setup.weth.balanceOf(subjectSetToken);
      const postWethOneBalance = await setup.weth.balanceOf(wethStake.address);
      const postWethTwoBalance = await setup.weth.balanceOf(wethTwoStake.address);

      const expectedTokensTransferred = preciseMul(subjectSetTokenQuantity, ether(1));

      expect(postSetTokenBalance).to.eq(preSetTokenBalance.add(expectedTokensTransferred));
      expect(postWethOneBalance).to.eq(preWethOneBalance.sub(expectedTokensTransferred.div(2)));
      expect(postWethTwoBalance).to.eq(preWethTwoBalance.sub(expectedTokensTransferred.div(2)));
    });

    describe("when staking contract doesn't return the expected amount of tokens", async () => {
      beforeEach(async () => {
        await wethStake.setUnstakeFee(ether(.01));
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Not enough tokens returned from stake contract");
      });
    });

    describe("if non-module is caller", async () => {
      beforeEach(async () => {
        subjectCaller = owner;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Only the module can call");
      });
    });

    describe("if disabled module is caller", async () => {
      beforeEach(async () => {
        await setup.controller.removeModule(dummyIssuanceModule.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Module must be enabled on controller");
      });
    });
  });
});
