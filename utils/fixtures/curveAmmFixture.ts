import { providers } from "ethers";
import { Address } from "../types";
import DeployHelper from "../deploys";
import { Signer } from "ethers";
import { CurveDeposit } from "../../typechain/CurveDeposit";
import { MetapoolStableSwap } from "@typechain/MetapoolStableSwap";
import { ether } from "@utils/common";
import { StandardTokenMock } from "@typechain/StandardTokenMock";
import { ethers } from "hardhat";
import dependencies from "@utils/deploys/dependencies";
import { CurveMetaPoolAmmAdapter } from "@typechain/CurveMetaPoolAmmAdapter";
import { ERC20 } from "@typechain/ERC20";
import MetapoolFactoryAbi from "../../external/abi/curve/MetapoolFactory.json";
import MetaPoolStableSwapAbi from "../../external/abi/curve/MetapoolStableSwap.json";
import { MetapoolFactory } from "@typechain/MetapoolFactory";
export class CurveAmmFixture {
  private _ownerAddress: Address;
  private _ownerSigner: Signer;
  private _deployer: DeployHelper;

  public mim: ERC20;
  public setToken: StandardTokenMock;
  public threeCrv: ERC20;
  public deposit: CurveDeposit;

  public metapoolFactory: MetapoolFactory;

  public poolToken: ERC20;
  public otherPoolToken: ERC20;
  public mim3CRVFactoryMetapool: MetapoolStableSwap;
  public otherMetapool: MetapoolStableSwap;

  public curveMetapoolAmmAdapter: CurveMetaPoolAmmAdapter;

  public underlying: Address[];

  constructor(provider: providers.Web3Provider | providers.JsonRpcProvider, ownerAddress: Address) {
    this._ownerAddress = ownerAddress;
    this._ownerSigner = provider.getSigner(ownerAddress);
    this._deployer = new DeployHelper(this._ownerSigner);
  }



  public async deployForkedContracts(): Promise<void> {
    this.mim = (await ethers.getContractAt("ERC20", dependencies.MIM[1])) as ERC20;
    this.threeCrv = (await ethers.getContractAt("ERC20", dependencies.THREE_CRV[1])) as ERC20;

    this.underlying = [this.mim.address, this.threeCrv.address];


    this.setToken = await this._deployer.mocks.deployTokenMock(
      this._ownerAddress,
      ether(1000000),
      18,
    );

    this.metapoolFactory = (await ethers.getContractAt(
      MetapoolFactoryAbi.abi,
      "0x0959158b6040D32d04c301A72CBFD6b39E21c9AE",
    )) as MetapoolFactory;

    this.mim3CRVFactoryMetapool = (await ethers.getContractAt(
      MetaPoolStableSwapAbi.abi,
      "0x5a6A4D54456819380173272A5E8E9B9904BdF41B",
    )) as MetapoolStableSwap; // MIM factory Metapool

    this.otherMetapool = (await ethers.getContractAt(
      MetaPoolStableSwapAbi.abi,
      "0x4f062658EaAF2C1ccf8C8e36D6824CDf41167956",
    )) as MetapoolStableSwap; // gusd Metapool

    this.poolToken = (await ethers.getContractAt(
      "ERC20",
      "0x5a6A4D54456819380173272A5E8E9B9904BdF41B",
    )) as ERC20; // MIMCRV LP

    this.otherPoolToken = (await ethers.getContractAt(
      "ERC20",
      "0xD2967f45c4f384DEEa880F807Be904762a3DeA07",
    )) as ERC20; // gusdCRV-LPiu

    this.curveMetapoolAmmAdapter = await this._deployer.adapters.deployCurveMetaPoolAmmAdapter(
      this.metapoolFactory.address
    );
  }
}
