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
import { IERC20__factory } from "@typechain/factories/IERC20__factory";
import dependencies from "@utils/deploys/dependencies";
import { TriPool__factory } from "@typechain/factories/TriPool__factory";
import { MetapoolStableSwap__factory } from "@typechain/factories/MetapoolStableSwap__factory";
import { MetapoolZap__factory } from "@typechain/factories/MetapoolZap__factory";
import { CurveMetaPoolAmmAdapter } from "@typechain/CurveMetaPoolAmmAdapter";
import { CurveRegistry__factory } from "@typechain/factories/CurveRegistry__factory";
import { IERC20 } from "@typechain/IERC20";
import { TriPoolZap__factory } from "@typechain/factories/TriPoolZap__factory";
import { TriPoolZap } from "@typechain/TriPoolZap";

export class CurveAmmFixture {
  private _provider: providers.Web3Provider | providers.JsonRpcProvider;
  private _ownerAddress: Address;
  private _ownerSigner: Signer;
  private _deployer: DeployHelper;

  public dai: IERC20;
  public usdc: IERC20;
  public usdt: IERC20;
  public gusd: IERC20;

  public setToken: StandardTokenMock;

  public threeCrv: IERC20;
  public triPool: TriPool;
  public deposit: CurveDeposit;

  public curveRegistry: CurveRegistry;

  public poolToken: IERC20;
  public metapool: MetapoolStableSwap;
  public metapoolZap: TriPoolZap;

  public curveMetapoolAmmAdapter: CurveMetaPoolAmmAdapter;

  public baseCoins: Address[];
  public underlying: Address[];

  constructor(provider: providers.Web3Provider | providers.JsonRpcProvider, ownerAddress: Address) {
    this._provider = provider;
    this._ownerAddress = ownerAddress;
    this._ownerSigner = provider.getSigner(ownerAddress);
    this._deployer = new DeployHelper(this._ownerSigner);
  }

  public getForkedDependencyAddresses() {
    return {
      whales: [
        dependencies.DAI_WHALE,
        dependencies.USDC_WHALE,
      ],

      tokens: [
        dependencies.DAI[1],
        dependencies.USDC[1],
        dependencies.USDT[1],
        dependencies.GUSD[1],
        dependencies.THREE_CRV[1],
      ],
    };
  }

  public async deployForkedContracts(): Promise<void> {
    enum ids {DAI, USDC, USDT, GUSD, THREE_CRV}
    const { whales, tokens } = this.getForkedDependencyAddresses();
    this.dai = IERC20__factory.connect(tokens[ids.DAI], this._provider.getSigner(whales[ids.DAI]));
    this.usdc = IERC20__factory.connect(tokens[ids.USDC], this._provider);
    this.usdt = IERC20__factory.connect(tokens[ids.USDT], this._provider);
    this.gusd = IERC20__factory.connect(tokens[ids.GUSD], this._provider);

    this.baseCoins = [this.dai.address, this.usdc.address, this.usdt.address];
    this.underlying = [this.gusd.address, ...this.baseCoins];

    this.threeCrv = IERC20__factory.connect(tokens[ids.THREE_CRV], this._provider);

    this.setToken = await this._deployer.mocks.deployTokenMock(this._ownerAddress, ether(1000000), 18);

    this.curveRegistry = CurveRegistry__factory.connect("0x7D86446dDb609eD0F5f8684AcF30380a356b2B4c", this._provider);
    this.metapoolZap = TriPoolZap__factory.connect("0x5F890841f657d90E081bAbdB532A05996Af79Fe6", this._provider);

    this.metapool = MetapoolStableSwap__factory.connect("0x4f062658EaAF2C1ccf8C8e36D6824CDf41167956", this._provider); // GUSD Pool
    this.poolToken = IERC20__factory.connect("0xD2967f45c4f384DEEa880F807Be904762a3DeA07", this._provider); // GUSD LP

    this.curveMetapoolAmmAdapter = await this._deployer.adapters.deployCurveMetaPoolAmmAdapter(this.curveRegistry.address, this.metapoolZap.address);
  }
}
