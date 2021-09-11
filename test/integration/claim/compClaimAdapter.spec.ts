import "module-alias/register";
import { waffle } from "hardhat";
import { Contract, BigNumber } from "ethers";
import { MockContract } from "@ethereum-waffle/mock-contract";
import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { ADDRESS_ZERO } from "@utils/constants";
import {
  CompClaimAdapter,
  ClaimModule,
  SetToken,
  StandardTokenMock,
} from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getSystemFixture,
  getWaffleExpect,
} from "@utils/test/index";
import { SystemFixture } from "@utils/fixtures";

const ComptrollerArtifact = require("../../../external/abi/compound/Comptroller.json");
const expect = getWaffleExpect();
const { deployMockContract } = waffle;

describe("CompClaimAdapter", function() {
  let owner: Account;
  let compoundAdmin: Account;
  let deployer: DeployHelper;
  let comptroller: Contract;
  let mockComptroller: MockContract;
  let compClaimAdapter: CompClaimAdapter;

  before(async function() {
    [
      owner,
      compoundAdmin,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
  });

  context("unit tests", async function() {

    before(async function() {
      mockComptroller = await deployMockContract(owner.wallet, ComptrollerArtifact.abi);
      compClaimAdapter = await deployer.adapters.deployCompClaimAdapter(mockComptroller.address);
    });

    describe("#getClaimCallData", async function() {
      let claimCallData: string;

      before(function() {
        claimCallData = mockComptroller.interface.encodeFunctionData("claimComp(address)", [ADDRESS_ZERO]);
      });

      function subject(): Promise<[Address, BigNumber, string]> {
        return compClaimAdapter.connect(owner.wallet).getClaimCallData(ADDRESS_ZERO, ADDRESS_ZERO);
      }

      it("should return claim callData", async function() {
        const callData = await subject();

        expect(callData[0]).to.eq(mockComptroller.address);
        expect(callData[1]).to.eq(ether(0));
        expect(callData[2]).to.eq(claimCallData);
      });
    });

    describe("#getRewardsAmount", async function() {
      const rewards: BigNumber = ether(1);

      before(async function() {
        await mockComptroller.mock.compAccrued.returns(rewards);
      });

      function subject(): Promise<BigNumber> {
        return compClaimAdapter.connect(owner.wallet).getRewardsAmount(ADDRESS_ZERO, ADDRESS_ZERO);
      }

      it("should return rewards", async function() {
        expect(await subject()).to.eq(rewards);
      });
    });

    describe("#getTokenAddress", async function() {
      before(async function() {
        await mockComptroller.mock.getCompAddress.returns(ADDRESS_ZERO);
      });

      function subject(): Promise<Address> {
        return compClaimAdapter.connect(owner.wallet).getTokenAddress(ADDRESS_ZERO);
      }

      it("should return comp address", async function() {
        const address = await subject();

        expect(address).to.eq(ADDRESS_ZERO);
      });
    });
  });

  context("integration with ClaimModule", async function() {
    let comp: StandardTokenMock, cToken: StandardTokenMock;
    let claimModule: ClaimModule;
    let setToken: SetToken;
    let setup: SystemFixture;

    const amount: BigNumber = ether(10);
    const anyoneClaim: boolean = true;
    const compClaimAdapterIntegrationName: string = "COMP_CLAIM";
    const integrations: string[] = [compClaimAdapterIntegrationName];

    before(async function() {
      comp = await deployer.mocks.deployTokenMock(compoundAdmin.address, amount, 18);
      cToken = await deployer.mocks.deployTokenMock(compoundAdmin.address, amount, 18);
      comptroller = await deployer.mocks.deployComptrollerMock(comp.address, amount, cToken.address);
      compClaimAdapter = await deployer.adapters.deployCompClaimAdapter(comptroller.address);

      setup = getSystemFixture(owner.address);
      await setup.initialize();

      claimModule = await deployer.modules.deployClaimModule(setup.controller.address);
      await setup.controller.addModule(claimModule.address);
      await setup.integrationRegistry.addIntegration(claimModule.address, compClaimAdapterIntegrationName, compClaimAdapter.address);

      setToken = await setup.createSetToken(
        [setup.weth.address],
        [ether(1)],
        [claimModule.address]
      );

      await claimModule.connect(owner.wallet).initialize(setToken.address, anyoneClaim, [comptroller.address], integrations);
    });

    addSnapshotBeforeRestoreAfterEach();

    describe("ClaimModule#getRewards", async function() {
      const amount: BigNumber = ether(0.1);

      before(async () => {
        await comptroller.setCompAccrued(setToken.address, amount);
      });

      async function subject(): Promise<any> {
        return claimModule.connect(owner.wallet).getRewards(setToken.address, comptroller.address, compClaimAdapterIntegrationName);
      }

      it("should return accrued amount", async () => {
        const result: number = await subject();

        expect(result).to.eq(amount);
      });
    });

    describe("ClaimModule#claim", async function() {
      const amount: BigNumber = ether(0.1);

      before(async function() {
        await comp.mint(comptroller.address, amount);
        await comptroller.setCompAccrued(setToken.address, amount);
      });

      function subject(): Promise<any> {
        return claimModule.connect(owner.wallet).claim(setToken.address, comptroller.address, compClaimAdapterIntegrationName);
      }

      it("should dispatch RewardClaimed event", async function() {
        const claim = await subject();
        const receipt = await claim.wait();

        // Get RewardClaimed event dispatched in a ClaimModule#_claim call
        const rewardClaimed: any = receipt.events.find((e: any): any => e.event == "RewardClaimed");

        expect(rewardClaimed.args![3]).to.eq(amount);
      });

      it("should claim accrued amount", async function() {
        const initialCompBalance = await comp.balanceOf(setToken.address);

        await subject();

        const finalCompBalance = await comp.balanceOf(setToken.address);
        const expectedBalance = initialCompBalance.add(amount);

        expect(finalCompBalance).to.equal(expectedBalance);
      });
    });
  });
});
