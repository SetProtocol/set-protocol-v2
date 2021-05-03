import "module-alias/register";

import { ethers } from "hardhat";
import { BigNumber } from "@ethersproject/bignumber";
import { SetToken } from "@utils/contracts";
import {
  ether,
  usdc,
} from "@utils/index";
import {
  getSystemFixture,
  getWaffleExpect,
  getAccounts,
} from "@utils/test/index";

import { Address } from "@utils/types";
import { Account } from "@utils/test/types";
import { SystemFixture } from "@utils/fixtures";

const expect = getWaffleExpect();

describe("Optimism L2 Core [ @ovm ]", () => {
  let owner: Account, moduleOne: Account;
  let setToken: SetToken;
  let setup: SystemFixture;

  let components: Address[];
  let units: BigNumber[];
  let modules: Address[];

  before(async () => {
    [owner, moduleOne] = await getAccounts();

    setup = getSystemFixture(owner.address);
    await setup.initialize();

    await setup.controller.addModule(moduleOne.address);

    components = [setup.usdc.address, setup.dai.address];

    units = [usdc(100), ether(1)];
    modules = [moduleOne.address];

    setToken = await setup.createSetToken(components, units, modules);
    setToken = setToken.connect(moduleOne.wallet);
    await setToken.initializeModule();
  });

  it("should be connected to optimism client", async function() {
    if (process.env.HARDHAT_EVM === "true") this.skip();

    const network = await ethers.provider.getNetwork();
    expect(network.chainId).to.equal(420);
  });

  it("should have deployed Controller", async () => {
    const code = await ethers.provider.getCode(setup.controller.address);
    expect(code.length).to.be.gt(2);
  });

  it("should have deployed BasicIssuance", async () => {
    const code = await ethers.provider.getCode(setup.issuanceModule.address);
    expect(code.length).to.be.gt(2);
  });

  it("should have deployed TokenMocks", async () => {
    const usdcCode = await ethers.provider.getCode(setup.usdc.address);
    const wbtcCode = await ethers.provider.getCode(setup.wbtc.address);
    const daiCode = await ethers.provider.getCode(setup.dai.address);

    expect(usdcCode.length).to.be.gt(2);
    expect(wbtcCode.length).to.be.gt(2);
    expect(daiCode.length).to.be.gt(2);
  });

  it("should have deployed OracleMocks", async () => {
    const usdcCode = await ethers.provider.getCode(setup.USD_USD_Oracle.address);
    const wbtcCode = await ethers.provider.getCode(setup.BTC_USD_Oracle.address);
    const daiCode = await ethers.provider.getCode(setup.DAI_USD_Oracle.address);

    expect(usdcCode.length).to.be.gt(2);
    expect(wbtcCode.length).to.be.gt(2);
    expect(daiCode.length).to.be.gt(2);
  });

  it("should have deployed IntegrationRegistry", async () => {
    const code = await ethers.provider.getCode(setup.integrationRegistry.address);
    expect(code.length).to.be.gt(2);
  });

  it("should have deployed SetTokenCreator", async () => {
    const code = await ethers.provider.getCode(setup.factory.address);
    expect(code.length).to.be.gt(2);
  });

  it("should have deployed PriceOracle", async () => {
    const code = await ethers.provider.getCode(setup.priceOracle.address);
    expect(code.length).to.be.gt(2);
  });

  it("should have deployed SetValuer", async () => {
    const code = await ethers.provider.getCode(setup.setValuer.address);
    expect(code.length).to.be.gt(2);
  });

  it("should have deployed StreamingFeeModule", async () => {
    const code = await ethers.provider.getCode(setup.streamingFeeModule.address);
    expect(code.length).to.be.gt(2);
  });

  it("should have created a SetToken", async () => {
    const code = await ethers.provider.getCode(setToken.address);
    expect(code.length).to.be.gt(2);
  });
});