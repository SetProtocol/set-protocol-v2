import { Signer } from "ethers";

import { ProtocolViewer } from "../contracts";


import { ProtocolViewerFactory } from "../../typechain/ProtocolViewerFactory";

export default class DeployViewers {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployProtocolViewer(): Promise<ProtocolViewer> {
    return await new ProtocolViewerFactory(this._deployerSigner).deploy();
  }
}