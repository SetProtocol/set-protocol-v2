import { Signer } from "ethers";

import { ProtocolViewer } from "../contracts";


import { ProtocolViewer__factory } from "../../typechain/factories/ProtocolViewer__factory";

export default class DeployViewers {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployProtocolViewer(): Promise<ProtocolViewer> {
    return await new ProtocolViewer__factory(this._deployerSigner).deploy();
  }
}