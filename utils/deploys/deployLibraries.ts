import { Signer } from "ethers";

import {
  AaveV2,
  Compound,
  PerpV2
} from "../contracts";

import { Compound__factory } from "../../typechain/factories/Compound__factory";
import { AaveV2__factory } from "../../typechain/factories/AaveV2__factory";
import { PerpV2__factory } from "../../typechain/factories/PerpV2__factory";

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

  public async deployPerpV2(): Promise<PerpV2> {
    return await new PerpV2__factory(this._deployerSigner).deploy();
  }
}
