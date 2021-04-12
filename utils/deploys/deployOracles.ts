import { Signer } from "ethers";
import { Address } from "../types";
import { BigNumber } from "@ethersproject/bignumber";

import {
  CTokenOracle,
} from "../contracts";

import { CTokenOracle__factory } from "../../typechain/factories/CTokenOracle__factory";

export default class DeployOracles {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployCTokenOracle(
    cToken: Address,
    underlyingOracle: Address,
    cTokenFullUnit: BigNumber,
    underlyingFullUnit: BigNumber,
    dataDescription: string): Promise<CTokenOracle> {
    return await new CTokenOracle__factory(this._deployerSigner)
      .deploy(cToken, underlyingOracle, cTokenFullUnit, underlyingFullUnit, dataDescription);
  }
}
