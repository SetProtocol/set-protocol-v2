import { Signer } from "ethers";

import DeployMocks from "./deployMocks";
import DeployModules from "./deployModules";
import DeployCoreContracts from "./deployCoreContracts";
import DeployExternalContracts from "./deployExternal";
import DeployAdapters from "./deployAdapters";
import DeployViewers from "./deployViewers";
import DeployProduct from "./deployProduct";

export default class DeployHelper {
  public mocks: DeployMocks;
  public modules: DeployModules;
  public core: DeployCoreContracts;
  public external: DeployExternalContracts;
  public adapters: DeployAdapters;
  public viewers: DeployViewers;
  public product: DeployProduct;

  constructor(deployerSigner: Signer) {
    this.mocks = new DeployMocks(deployerSigner);
    this.modules = new DeployModules(deployerSigner);
    this.core = new DeployCoreContracts(deployerSigner);
    this.external = new DeployExternalContracts(deployerSigner);
    this.adapters = new DeployAdapters(deployerSigner);
    this.viewers = new DeployViewers(deployerSigner);
    this.product = new DeployProduct(deployerSigner);
  }
}


