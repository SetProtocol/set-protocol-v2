import { Signer } from "ethers";
import { BigNumberish } from "ethers/utils";

import {
  Controller,
  IntegrationRegistry,
  PriceOracle,
  SetToken,
  SetTokenCreator,
  SetValuer
} from "./../contracts";

import { Address } from "./../types";

import { ControllerFactory } from "../../typechain/ControllerFactory";
import { IntegrationRegistryFactory } from "../../typechain/IntegrationRegistryFactory";
import { PriceOracleFactory } from "../../typechain/PriceOracleFactory";
import { SetTokenFactory } from "../../typechain/SetTokenFactory";
import { SetTokenCreatorFactory } from "../../typechain/SetTokenCreatorFactory";
import { SetValuerFactory } from "../../typechain/SetValuerFactory";

export default class DeployCoreContracts {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployController(feeRecipient: Address): Promise<Controller> {
    return await new ControllerFactory(this._deployerSigner).deploy(feeRecipient);
  }

  public async getController(controllerAddress: Address): Promise<Controller> {
    return await new ControllerFactory(this._deployerSigner).attach(controllerAddress);
  }

  public async deploySetTokenCreator(controller: Address): Promise<SetTokenCreator> {
    return await new SetTokenCreatorFactory(this._deployerSigner).deploy(controller);
  }

  public async getSetTokenCreator(setTokenCreatorAddress: Address): Promise<SetTokenCreator> {
    return await new SetTokenCreatorFactory(this._deployerSigner).attach(setTokenCreatorAddress);
  }

  public async deploySetToken(
    _components: Address[],
    _units: BigNumberish[],
    _modules: Address[],
    _controller: Address,
    _manager: Address,
    _name: string,
    _symbol: string,
  ): Promise<SetToken> {
    return await new SetTokenFactory(this._deployerSigner).deploy(
      _components,
      _units,
      _modules,
      _controller,
      _manager,
      _name,
      _symbol,
    );
  }

  public async getSetToken(setTokenAddress: Address): Promise<SetToken> {
    return await new SetTokenFactory(this._deployerSigner).attach(setTokenAddress);
  }

  public async deployPriceOracle(
    controller: Address,
    masterQuoteAsset: Address,
    adapters: Address[],
    assetOnes: Address[],
    assetTwos: Address[],
    oracles: Address[],
  ): Promise<PriceOracle> {
    return await new PriceOracleFactory(this._deployerSigner).deploy(
      controller,
      masterQuoteAsset,
      adapters,
      assetOnes,
      assetTwos,
      oracles,
    );
  }

  public async getPriceOracle(priceOracleAddress: Address): Promise<PriceOracle> {
    return await new PriceOracleFactory(this._deployerSigner).attach(priceOracleAddress);
  }

  public async deployIntegrationRegistry(controller: Address): Promise<IntegrationRegistry> {
    return await new IntegrationRegistryFactory(this._deployerSigner).deploy(controller);
  }

  public async getIntegrationRegistry(integrationRegistryAddress: Address): Promise<IntegrationRegistry> {
    return await new IntegrationRegistryFactory(this._deployerSigner).attach(integrationRegistryAddress);
  }

  public async deploySetValuer(controller: Address): Promise<SetValuer> {
    return await new SetValuerFactory(this._deployerSigner).deploy(controller);
  }
}
