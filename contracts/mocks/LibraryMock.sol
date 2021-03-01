pragma solidity 0.6.10;

library LibraryMock {
  function addOne(uint x) public pure returns (uint){
    return x + 1;
  }
}