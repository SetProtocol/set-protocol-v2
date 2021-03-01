pragma solidity 0.6.10;

import "./LibraryMock.sol";

contract LibraryConsumerMock {
  uint x;

  function plus() public view returns (uint) {
    return LibraryMock.addOne(x);
  }
}
