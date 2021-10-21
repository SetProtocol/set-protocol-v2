/*
    Copyright 2021 Set Labs Inc.

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.

    SPDX-License-Identifier: Apache License, Version 2.0
*/

pragma solidity 0.6.10;

import { SafeCast } from "@openzeppelin/contracts/utils/SafeCast.sol";

import { IAmmAdapter } from "../../../interfaces/IAmmAdapter.sol";
import { IMetapoolFactory } from "../../../interfaces/external/IMetapoolFactory.sol";
import { IMetaPoolZap } from "../../../interfaces/external/IMetaPoolZap.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract CurveMetaPoolAmmAdapter is IAmmAdapter {
    using SafeCast for uint256;
    using SafeCast for int256;

    IMetapoolFactory public metapoolFactory;
    address public constant THREE_CRV = address(0x6c3F90f043a72FA612cbac8115EE7e52BDe6E490);

    string public constant ADD_LIQUIDITY = "add_liquidity(uint256[2],uint256,address)";
    string public constant REMOVE_LIQUIDITY = "remove_liquidity(uint256,uint256[2],address)";
    string public constant REMOVE_LIQUIDITY_SINGLE = "remove_liquidity_one_coin(uint256,int128,uint256,address)";

    constructor(IMetapoolFactory _metapoolFactory) public {
        metapoolFactory = _metapoolFactory;
    }

    function getProvideLiquidityCalldata(
        address _setToken,
        address _pool,
        address[] calldata _components,
        uint256[] calldata _maxTokensIn,
        uint256 _minLiquidity
    )
        external
        view
        override
        returns (address, uint256, bytes memory)
    {
        require(_isValidPool(_pool, _components), "invalid pool");
        require(_maxTokensIn[0] > 0 && _maxTokensIn[1] > 0, "tokens in must be nonzero");
        uint256[2] memory inputAmounts = _convertUintArrayLiteral(_maxTokensIn);

        bytes memory callData = abi.encodeWithSignature(
            ADD_LIQUIDITY,
            inputAmounts,
            _minLiquidity,
            _setToken
        );

        return (_pool, 0, callData);
    }

    function getProvideLiquiditySingleAssetCalldata(
        address _setToken,
        address _pool,
        address _component,
        uint256 _maxTokenIn,
        uint256 _minLiquidity
    )
        external
        view
        override
        returns (address, uint256, bytes memory)
    {
        uint256 tokenIndex = _getTokenIndex(_pool, _component);

        uint256[2] memory inputAmounts;
        inputAmounts[tokenIndex] = _maxTokenIn;

        bytes memory callData = abi.encodeWithSignature(
            ADD_LIQUIDITY,
            inputAmounts,
            _minLiquidity,
            _setToken
        );

        return (_pool, 0, callData);
    }

    function getRemoveLiquidityCalldata(
        address _setToken,
        address _pool,
        address[] calldata _components,
        uint256[] calldata _minTokensOut,
        uint256 _liquidity
    )
        external
        view
        override
        returns (address, uint256, bytes memory)
    {
        require(_isValidPool(_pool, _components), "invalid pool");

        uint256[2] memory outputAmounts = _convertUintArrayLiteral(_minTokensOut);

        bytes memory callData = abi.encodeWithSignature(
            REMOVE_LIQUIDITY,
            _liquidity,
            outputAmounts,
            _setToken
        );

        return (_pool, 0, callData);
    }

    function getRemoveLiquiditySingleAssetCalldata(
        address _setToken,
        address _pool,
        address _component,
        uint256 _minTokenOut,
        uint256 _liquidity
    )
        external
        view
        override
        returns (address, uint256, bytes memory)
    {
        int128 i = _getTokenIndex(_pool, _component).toInt256().toInt128();

        bytes memory callData = abi.encodeWithSignature(
            REMOVE_LIQUIDITY_SINGLE,
            _liquidity,
            i,
            _minTokenOut,
            _setToken
        );

        return (_pool, 0, callData);
    }

    function getSpenderAddress(address _pool) external view override returns(address) {
        return _pool;
    }

    function isValidPool(address _pool, address[] memory _components) external view override returns(bool) {
        return _isValidPool(_pool, _components);
    }

    function _isValidPool(address _pool, address[] memory _components) internal view returns(bool) {
        address[2] memory expectedTokens = metapoolFactory.get_coins(_pool);

        for (uint256 i = 0; i < _components.length; i++) {
            if ((_components[i] == expectedTokens[0] || _components[i] == expectedTokens[1]) == false) {
                return false;
            }
        }

        return true;
    }

    function _convertUintArrayLiteral(uint256[] memory _arr) internal pure returns (uint256[2] memory _literal) {
        for (uint256 i = 0; i < 2; i++) {
            _literal[i] = _arr[i];
        }
        return _literal;
    }

    function _getTokenIndex(address _pool, address _token) internal view returns (uint256) {
        address[2] memory underlying = metapoolFactory.get_coins(_pool);
        for (uint256 i = 0; i < 2; i++) {
            if (underlying[i] == _token) return i;
        }
        revert("token not in pool");
    }
}