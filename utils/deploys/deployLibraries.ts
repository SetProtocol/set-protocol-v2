import { Signer } from "ethers";

import {
  AaveV2,
  Compound,
} from "../contracts";

import { Compound__factory } from "../../typechain/factories/Compound__factory";
import { AaveV2__factory } from "../../typechain/factories/AaveV2__factory";

export default class DeployLibraries {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployCompound(): Promise<Compound> {
    return await new Compound__factory(this._deployerSigner).deploy();
  }

  public async deployAaveV2(): Promise<AaveV2> {
    return await new AaveV2__factory(this._deployerSigner).deploy();
  }
}
