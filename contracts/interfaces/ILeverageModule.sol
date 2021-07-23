pragma solidity 0.6.10;

import { ISetToken } from "../interfaces/ISetToken.sol";

/**
 * @title ILeverageModule
 * @author Set Protocol
 */
interface ILeverageModule {
    function sync(ISetToken _setToken, bool _shouldAccrueInterest) external;
}