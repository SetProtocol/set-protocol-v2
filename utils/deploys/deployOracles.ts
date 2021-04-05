import { Signer } from "ethers";
import { Address } from "../types";
import { BigNumber } from "@ethersproject/bignumber";

import {
  YearnVaultOracle,
} from "../contracts";

import { YearnVaultOracle__factory } from "../../typechain/factories/YearnVaultOracle__factory";

export default class DeployOracles {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployYearnVaultOracle(
    vault: Address,
    underlyingOracle: Address,
    underlyingFullUnit: BigNumber,
    dataDescription: string): Promise<YearnVaultOracle> {
    return await new YearnVaultOracle__factory(this._deployerSigner).deploy(vault, underlyingOracle, underlyingFullUnit, dataDescription);
  }
}
