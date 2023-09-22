module.exports = {
  skipFiles: [
    'mocks',
    'interfaces',
    'protocol/modules/UniswapYieldStrategy.sol',
    'product/AssetLimitHook.sol',
    'protocol-viewers'
  ],
  modifierWhitelist: [
    'nonReentrant'  // OpenZeppelin
  ]
}