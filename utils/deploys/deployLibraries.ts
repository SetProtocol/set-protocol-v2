import { Signer } from "ethers";

import {
  Compound,
  ComponentPositions,
} from "../contracts";

import { Compound__factory } from "../../typechain/factories/Compound__factory";
import { ComponentPositions__factory } from "../../typechain/factories/ComponentPositions__factory";

export default class DeployLibraries {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployCompound(): Promise<Compound> {
    return await new Compound__factory(this._deployerSigner).deploy();
  }

  public async deployComponentPositions(): Promise<ComponentPositions> {
    return await new ComponentPositions__factory(this._deployerSigner).deploy();
  }
}
