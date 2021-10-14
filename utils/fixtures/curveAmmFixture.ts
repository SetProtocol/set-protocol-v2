import { providers } from "ethers";
import { Address } from "../types";
import DeployHelper from "../deploys";
import { Signer } from "ethers";
import { CurvePoolERC20 } from "../../typechain/CurvePoolERC20";
import { Stableswap } from "../../typechain/Stableswap";
import { CurveDeposit } from "../../typechain/CurveDeposit";
import { CRVToken } from "../../typechain/CRVToken";
import { GaugeController } from "../../typechain/GaugeController";
import { Minter } from "../../typechain/Minter";
import { CurveAddressProvider } from "@typechain/CurveAddressProvider";
import { CurveRegistry } from "@typechain/CurveRegistry";
import { MetapoolZap } from "@typechain/MetapoolZap";
import { MetapoolStableSwap } from "@typechain/MetapoolStableSwap";
import { BigNumber } from "@ethersproject/bignumber";
import { TriPool } from "@typechain/TriPool";
import { ether } from "@utils/common";
import { StandardTokenMock } from "@typechain/StandardTokenMock";
import { ethers } from "hardhat";

export class CurveAmmFixture {
  private _deployer: DeployHelper;
  private _ownerSigner: Signer;

  public dai: StandardTokenMock;
  public usdc: StandardTokenMock;
  public usdt: StandardTokenMock;
  public usdn: StandardTokenMock;

  public threeCrv: CurvePoolERC20;
  public triPool: TriPool;
  public deposit: CurveDeposit;

  public crvToken: CRVToken;
  public gaugeController: GaugeController;
  public minter: Minter;

  public addressProvider: CurveAddressProvider;
  public curveRegistry: CurveRegistry;

  public poolToken: CurvePoolERC20;
  public metaPool: MetapoolStableSwap;
  public metaPoolZap: MetapoolZap;

  public stableSwap: Stableswap;

  constructor(provider: providers.Web3Provider | providers.JsonRpcProvider, ownerAddress: Address) {
    this._ownerSigner = provider.getSigner(ownerAddress);
    this._deployer = new DeployHelper(this._ownerSigner);
  }

  /**
   * Initializes a pool.
   * @param _tokens Expects 4 tokens
   */
  public async initializePool(ownerAddress: string): Promise<void> {
    this.dai = await this._deployer.mocks.deployTokenMock(ownerAddress, ether(1000000), 18);
    this.usdc = await this._deployer.mocks.deployTokenMock(ownerAddress, ether(1000000), 6);
    this.usdt = await this._deployer.mocks.deployTokenMock(ownerAddress, ether(1000000), 6);
    this.usdn = await this._deployer.mocks.deployTokenMock(ownerAddress, ether(1000000), 18);

    this.threeCrv = await this._deployer.external.deployCurvePoolERC20(
      "Curve.fi DAI/USDC/USDT/sUSD",
      "crvUSD",
      18,
      0,
    );

    this.stableSwap = await this._deployer.external.deployStableswap(
      [this.dai.address, this.usdc.address, this.usdt.address, this.usdn.address],
      [this.dai.address, this.usdc.address, this.usdt.address, this.usdn.address],
      this.threeCrv.address,
    );

    this.deposit = await this._deployer.external.deployCurveDeposit(
      [this.dai.address, this.usdc.address, this.usdt.address,this.usdn.address],
      [this.dai.address, this.usdc.address, this.usdt.address,this.usdn.address],
      this.stableSwap.address,
      this.threeCrv.address,
    );

    await this.threeCrv.set_minter(this.stableSwap.address);

    await this.dai.connect(this._ownerSigner).approve(this.deposit.address, ether(1000000));
    await this.usdc.connect(this._ownerSigner).approve(this.deposit.address, ether(1000000));
    await this.usdt.connect(this._ownerSigner).approve(this.deposit.address, ether(1000000));
    await this.usdn.connect(this._ownerSigner).approve(this.deposit.address, ether(1000000));


    //Prerequisites MetapoolZap
    this.addressProvider = await this._deployer.external.deployCurveAddressProvider(
      await this._ownerSigner.getAddress(),
    );

    this.gaugeController = await this._deployer.external.deployGaugeController(
      this.dai.address,
      this.dai.address,
    );

    this.curveRegistry = await this._deployer.external.deployCurveRegistry(
      this.addressProvider.address,
      this.gaugeController.address,
    );

    //MetaPool
    this.poolToken = await this._deployer.external.deployCurvePoolERC20(
      "Curve.fi DAI/USDC/USDT",
      "3CRV",
      18,
      0,
    );

    await this.deposit.add_liquidity(
          [
            BigNumber.from("1000000000000000000"),
            BigNumber.from("1000000"),
            BigNumber.from("1000000"),
            BigNumber.from("1000000000000000000"),
          ],
          BigNumber.from(0),
          {
            gasLimit: 9000000,
          },
        );

    this.metaPool = await this._deployer.external.deployCurveMetapoolStableSwap(
      await this._ownerSigner.getAddress(),
      [this.poolToken.address, this.threeCrv.address],
      this.poolToken.address,
      this.stableSwap.address,
      200,
      4000000,
      0,
    );

    await this.poolToken.set_minter(this.metaPool.address);


    //MetaPoolZap
    // this.metaPoolZap = await this._deployer.external.deployCurveMetapoolZap(
    //   this.metaPool.address,
    //   this.poolToken.address,
    // );

  }

  /**
   * Initializes a pool.
   * @param _tokens Expects 4 tokens
   */
  public async initialize(ownerAddress: string): Promise<void> {
    //this.crvToken = await this._deployer.external.deployCrvToken("Curve DAO Token", "CRV");
    this.dai = await this._deployer.mocks.deployTokenMock(ownerAddress, ether(1000000), 18);
    this.usdc = await this._deployer.mocks.deployTokenMock(ownerAddress, ether(1000000), 6);
    this.usdt = await this._deployer.mocks.deployTokenMock(ownerAddress, ether(1000000), 6);

    //3CRV Pool
    this.threeCrv = await this._deployer.external.deployCurvePoolERC20(
      "Curve.fi DAI/USDC/USDT",
      "3CRV",
      18,
      0,
    );


    this.triPool = await this._deployer.external.deployCurveTriPool(
      ownerAddress,
      [this.dai.address, this.usdc.address, this.usdt.address],
      this.threeCrv.address,
      100,
      4000000,
      0,
    );

    await this.threeCrv.set_minter(this.triPool.address);


    //Prerequisites MetapoolZap
    this.addressProvider = await this._deployer.external.deployCurveAddressProvider(
      await this._ownerSigner.getAddress(),
    );

    this.gaugeController = await this._deployer.external.deployGaugeController(
      this.crvToken.address,
      this.crvToken.address,
    );

    this.curveRegistry = await this._deployer.external.deployCurveRegistry(
      this.addressProvider.address,
      this.gaugeController.address,
    );

    //MetaPool
    this.poolToken = await this._deployer.external.deployCurvePoolERC20(
      "Curve.fi DAI/USDC/USDT",
      "3CRV",
      18,
      0,
    );

    console.log(await this.triPool.get_virtual_price())

    this.metaPool = await this._deployer.external.deployCurveMetapoolStableSwap(
      await this._ownerSigner.getAddress(),
      [this.poolToken.address, this.threeCrv.address],
      this.poolToken.address,
      this.triPool.address,
      200,
      4000000,
      0,
    );

    //MetaPoolZap
    this.metaPoolZap = await this._deployer.external.deployCurveMetapoolZap(
      this.metaPool.address,
      this.poolToken.address,
    );
  }
}
