import { Signer } from "ethers";

import {
  Compound,
} from "../contracts";

import { Compound__factory } from "../../typechain/factories/Compound__factory";

export default class DeployLibraries {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployCompound(): Promise<Compound> {
    return await new Compound__factory(this._deployerSigner).deploy();
  }
}
