// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.17;

/**
 * @title ConstantPriceAdapter
 * @author Index Coop
 * @notice Price adapter contract for AuctionRebalanceModuleV1 that returns a constant price.
 * The rate of change is zero.
 * Price formula: price = initialPrice
 */
contract ConstantPriceAdapter {
    /**
     * @dev Calculates and returns the constant price.
     *
     * @param _priceAdapterConfigData   Encoded bytes representing the constant price.
     *
     * @return price                    The constant price decoded from _priceAdapterConfigData.
     */
    function getPrice(
        address /* _setToken */,
        address /* _component */,
        uint256 /* _componentQuantity */,
        uint256 /* _timeElapsed */,
        uint256 /* _duration */,
        bytes memory _priceAdapterConfigData
    )
        external
        pure
        returns (uint256 price)
    {
        price = getDecodedData(_priceAdapterConfigData);
        require(price > 0, "ConstantPriceAdapter: Price must be greater than 0");
    }

    /**
     * @notice Returns true if the price adapter configuration data is valid.
     * 
     * @param _priceAdapterConfigData   Encoded bytes representing the constant price.
     * 
     * @return isValid                  True if the constant price is greater than 0, False otherwise.
     */
    function isPriceAdapterConfigDataValid(
        bytes memory _priceAdapterConfigData
    )
        external
        pure
        returns (bool isValid)
    {
        uint256 price = getDecodedData(_priceAdapterConfigData);
        isValid = price > 0;
    }

    /**
     * @notice Encodes the constant price into bytes.
     *
     * @param _price  The constant price in base units.
     *
     * @return        Encoded bytes representing the constant price.
     */
    function getEncodedData(uint256 _price) external pure returns (bytes memory) {
        return abi.encode(_price);
    }

    /**
     * @dev Decodes the constant price from the provided bytes.
     *
     * @param _data  Encoded bytes representing the constant price.
     *
     * @return       The constant price decoded from bytes in base units.
     */
    function getDecodedData(bytes memory _data) public pure returns (uint256) {
        return abi.decode(_data, (uint256));
    }
}
