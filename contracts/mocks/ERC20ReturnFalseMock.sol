pragma solidity 0.6.10;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract ERC20ReturnFalseMock is ERC20 {
    constructor(
        string memory _name,
        string memory _symbol,
        uint8 _decimals
    )
        public
        ERC20(_name, _symbol)
    {
        _setupDecimals(_decimals);
    }

    function transfer(address, uint256) public override returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) public override returns (bool) {
        return false;
    }

    function approve(address, uint256) public override returns (bool) {
        return false;
    }
}
