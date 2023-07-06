// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.17;

import { FixedPointMathLib } from "solady/src/utils/FixedPointMathLib.sol";

/**
 * @title BoundedStepwiseLinearPriceAdapter
 * @author Index Coop
 * @notice Price adapter contract for the AuctionRebalanceModuleV1. It returns a price that
 * increases or decreases linearly in steps over time, within a bounded range.
 * The rate of change is constant.
 * Price formula: price = initialPrice +/- slope * timeBucket
 */
contract BoundedStepwiseLinearPriceAdapter {

    /**
     * @dev Calculates and returns the linear price.
     *
     * @param _timeElapsed              Time elapsed since the start of the auction.
     * @param _priceAdapterConfigData   Encoded bytes representing the linear function parameters.
     *
     * @return price                    The price calculated using the linear function.
     */
    function getPrice(
        address /* _setToken */,
        address /* _component */,
        uint256 /* _componentQuantity */,
        uint256 _timeElapsed,
        uint256 /* _duration */,
        bytes memory _priceAdapterConfigData
    )
        external
        pure
        returns (uint256 price)
    {
        (
            uint256 initialPrice,
            uint256 slope,
            uint256 bucketSize,
            bool isDecreasing,
            uint256 maxPrice,
            uint256 minPrice
        ) = getDecodedData(_priceAdapterConfigData);

        require(
            areParamsValid(initialPrice, slope, bucketSize, maxPrice, minPrice), 
            "BoundedStepwiseLinearPriceAdapter: Invalid params"
        );

        uint256 bucket = _timeElapsed / bucketSize;

        // Protect against priceChange overflow
        if (bucket > type(uint256).max / slope) {
            return isDecreasing ? minPrice : maxPrice;
        }

        uint256 priceChange = bucket * slope;

        if (isDecreasing) {
            // Protect against price underflow
            if (priceChange > initialPrice) {
                return minPrice;
            }
            return FixedPointMathLib.max(initialPrice - priceChange, minPrice);
        } else {
            // Protect against price overflow
            if (priceChange > type(uint256).max - initialPrice) {
                return maxPrice;
            }
            return FixedPointMathLib.min(initialPrice + priceChange, maxPrice);
        }
    }

    /**
     * @dev Returns true if the price adapter is valid for the given parameters.
     * 
     * @param _priceAdapterConfigData   Encoded data for configuring the price adapter.
     * 
     * @return isValid                  Boolean indicating if the adapter config data is valid.
     */
    function isPriceAdapterConfigDataValid(
        bytes memory _priceAdapterConfigData
    )
        external
        pure
        returns (bool isValid)
    {
        (
            uint256 initialPrice,
            uint256 slope,
            uint256 bucketSize,
            ,
            uint256 maxPrice,
            uint256 minPrice
        ) = getDecodedData(_priceAdapterConfigData);

        return areParamsValid(initialPrice, slope, bucketSize, maxPrice, minPrice);
    }

    /**
     * @dev Returns true if the price adapter parameters are valid.
     * 
     * @param _initialPrice      Initial price of the auction
     * @param _bucketSize        Time elapsed between each bucket
     * @param _maxPrice          Maximum price of the auction
     * @param _minPrice          Minimum price of the auction
     */
    function areParamsValid(
        uint256 _initialPrice,
        uint256 _slope,
        uint256 _bucketSize,
        uint256 _maxPrice,
        uint256 _minPrice
    )
        public
        pure
        returns (bool)
    {
        return _initialPrice > 0
            && _slope > 0
            && _bucketSize > 0
            && _initialPrice <= _maxPrice
            && _initialPrice >= _minPrice;
    }

    /**
     * @dev Returns the encoded data for the price curve parameters
     * 
     * @param _initialPrice      Initial price of the auction
     * @param _slope             Slope of the linear price change
     * @param _bucketSize        Time elapsed between each bucket
     * @param _isDecreasing      Flag for whether the price is decreasing or increasing
     * @param _maxPrice          Maximum price of the auction
     * @param _minPrice          Minimum price of the auction
     */
    function getEncodedData(
        uint256 _initialPrice,
        uint256 _slope,
        uint256 _bucketSize,
        bool _isDecreasing,
        uint256 _maxPrice,
        uint256 _minPrice
    )
        external
        pure
        returns (bytes memory data)
    {
        return abi.encode(_initialPrice, _slope, _bucketSize, _isDecreasing, _maxPrice, _minPrice);
    }

    /**
     * @dev Decodes the parameters from the provided bytes.
     *
     * @param _data           Bytes encoded auction parameters
     * @return initialPrice   Initial price of the auction
     * @return slope          Slope of the linear price change
     * @return bucketSize     Time elapsed between each bucket
     * @return isDecreasing   Flag for whether the price is decreasing or increasing
     * @return maxPrice       Maximum price of the auction
     * @return minPrice       Minimum price of the auction
     */
    function getDecodedData(bytes memory _data)
        public
        pure
        returns (uint256 initialPrice, uint256 slope, uint256 bucketSize, bool isDecreasing, uint256 maxPrice, uint256 minPrice)
    {
        return abi.decode(_data, (uint256, uint256, uint256, bool, uint256, uint256));
    }
}
