import "module-alias/register";

import { ethers } from "hardhat";
import { BigNumber } from "ethers";

import { Account } from "@utils/test/types";
import DeployHelper from "@utils/deploys";
import { ether } from "@utils/index";
import {
  getAccounts,
  getWaffleExpect,
} from "@utils/test/index";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import {
  APYRescue,
  BasicIssuanceModule,
  Controller,
  SetToken,
  TokenEnabler,
  WETH9
} from "@utils/contracts";

const expect = getWaffleExpect();

describe.skip("APYRescue [ @forked-mainnet ]", () => {
  let controller: Controller;
  let basicIssuanceModule: BasicIssuanceModule;

  let ethusdToken: SetToken;
  let weth: WETH9;
  let wbtc: WETH9;   // just use WETH9 since it has everything we need for testing purposes

  let owner: Account;
  let multiSig: SignerWithAddress;
  let setOwner: SignerWithAddress;

  let apyRescue: APYRescue;
  let tokenEnabler: TokenEnabler;

  let deployer: DeployHelper;

  before(async () => {
    [ owner ] = await getAccounts();

    multiSig = await ethers.getImpersonatedSigner("0x9b52465793cBce01DEbd9b3c2B029dc69d19D255");
    setOwner = await ethers.getImpersonatedSigner("0xEf1863a13b8Dfa1Bd542f1aF79A38C18b9169E30"); // 59 ETHUSD tokens

    await owner.wallet.sendTransaction({
      to: multiSig.address,
      value: ether(1)
    });

    deployer = new DeployHelper(owner.wallet);

    controller = await deployer.core.getController("0xa4c8d221d8BB851f83aadd0223a8900A6921A349");
    basicIssuanceModule = await deployer.modules.getBasicIssuanceModule("0xd8EF3cACe8b4907117a45B0b125c68560532F94D");
    ethusdToken = await deployer.core.getSetToken("0x23687D9d40F9Ecc86E7666DDdB820e700F954526");  // ETHUSD now has WETH and WBTC in it
    weth = await deployer.external.getWETH("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
    wbtc = await deployer.external.getWETH("0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599");

    apyRescue = await deployer.product.deployAPYRescue(
      ethusdToken.address,
      [weth.address, wbtc.address],
      basicIssuanceModule.address
    );
    tokenEnabler = await deployer.product.deployTokenEnabler(controller.address, [ethusdToken.address]);

    await apyRescue.transferOwnership(multiSig.address);
    await tokenEnabler.transferOwnership(multiSig.address);

    await controller.connect(multiSig).addFactory(tokenEnabler.address);
  });

  describe("#deposit", async () => {
    let subjectAmount: BigNumber;
    let subjectCaller: SignerWithAddress;

    beforeEach(async () => {
      subjectAmount = ether(50);
      subjectCaller = setOwner;

      await ethusdToken.connect(setOwner).approve(apyRescue.address, subjectAmount);
    });

    async function subject(): Promise<any> {
      return await apyRescue.connect(subjectCaller).deposit(subjectAmount);
    }

    it("should deposit the correct amount of ETHUSD tokens in the APYRescue contract and update shares state", async () => {
      await subject();

      const balance = await ethusdToken.balanceOf(apyRescue.address);
      const shares = await apyRescue.shares(setOwner.address);
      const totalShares = await apyRescue.totalShares();

      expect(balance).to.eq(subjectAmount);
      expect(shares).to.eq(subjectAmount);
      expect(totalShares).to.eq(subjectAmount);
    });
  });

  describe("#recoverAssets", async () => {
    let subjectCaller: SignerWithAddress;

    beforeEach(async () => {
      await tokenEnabler.connect(multiSig).enableTokens();

      subjectCaller = multiSig;
    });

    async function subject(): Promise<any> {
      return await apyRescue.connect(subjectCaller).recoverAssets();
    }

    it("should redeem all ETHUSD tokens in the APYRescue contract", async () => {
      const preSetBalance = await ethusdToken.balanceOf(apyRescue.address);
      expect(preSetBalance).to.eq(ether(50));

      await subject();

      const postSetBalance = await ethusdToken.balanceOf(apyRescue.address);
      expect(postSetBalance).to.eq(0);
    });
  });

  describe("#withdrawRecoveredFunds", async () => {
    let subjectCaller: SignerWithAddress;

    beforeEach(async () => {
      subjectCaller = setOwner;
    });

    async function subject(): Promise<any> {
      return await apyRescue.connect(subjectCaller).withdrawRecoveredFunds();
    }

    it("should withdraw all WETH and WBTC tokens in the APYRescue contract", async () => {
      const preWethRescueBalance = await weth.balanceOf(apyRescue.address);
      const preWethOwnerBalance = await weth.balanceOf(setOwner.address);

      const preWbtcRescueBalance = await wbtc.balanceOf(apyRescue.address);
      const preWbtcOwnerBalance = await wbtc.balanceOf(setOwner.address);

      await subject();

      const postWethRescueBalance = await weth.balanceOf(apyRescue.address);
      const postWethOwnerBalance = await weth.balanceOf(setOwner.address);

      const postWbtcRescueBalance = await wbtc.balanceOf(apyRescue.address);
      const postWbtcOwnerBalance = await wbtc.balanceOf(setOwner.address);

      expect(postWethRescueBalance).to.eq(0);
      expect(postWbtcRescueBalance).to.eq(0);
      expect(postWethOwnerBalance).to.eq(preWethOwnerBalance.add(preWethRescueBalance));
      expect(postWbtcOwnerBalance).to.eq(preWbtcOwnerBalance.add(preWbtcRescueBalance));
    });
  });
});
