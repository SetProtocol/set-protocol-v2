import "module-alias/register";

import { Address, Account } from "@utils/types";
import { ResourceIdentifierMock } from "@utils/contracts";
import DeployHelper from "@utils/deploys";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
} from "@utils/index";
import { SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("ResourceIdentifier", () => {
  let owner: Account;
  let deployer: DeployHelper;

  let resourceIdentifier: ResourceIdentifierMock;
  let setup: SystemFixture;

  before(async () => {
    [
      owner,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    setup = getSystemFixture(owner.address);
    await setup.initialize();

    resourceIdentifier = await deployer.mocks.deployResourceIdentifierMock();
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#getIntegrationRegistry", async () => {
    let subjectController: Address;

    beforeEach(async () => {
      subjectController = setup.controller.address;
    });

    async function subject(): Promise<any> {
      return resourceIdentifier.testGetIntegrationRegistry(subjectController);
    }

    it("should fetch the correct integration registry contract", async () => {
      const integrationRegistry = await subject();
      expect(integrationRegistry).to.eq(setup.integrationRegistry.address);
    });
  });

  describe("#getPriceOracle", async () => {
    let subjectController: Address;

    beforeEach(async () => {
      subjectController = setup.controller.address;
    });

    async function subject(): Promise<any> {
      return resourceIdentifier.testGetPriceOracle(subjectController);
    }

    it("should fetch the correct price oracle contract", async () => {
      const priceOracle = await subject();
      expect(priceOracle).to.eq(setup.priceOracle.address);
    });
  });

  describe("#getSetValuer", async () => {
    let subjectController: Address;

    beforeEach(async () => {
      subjectController = setup.controller.address;
    });

    async function subject(): Promise<any> {
      return resourceIdentifier.testGetSetValuer(subjectController);
    }

    it("should fetch the correct Set valuer contract", async () => {
      const setValuer = await subject();
      expect(setValuer).to.eq(setup.setValuer.address);
    });
  });
});