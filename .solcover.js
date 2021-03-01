module.exports = {
  skipFiles: [
    'mocks',
    'interfaces',
    'protocol/modules/UniswapYieldStrategy.sol',
    'product/AssetLimitHook.sol',
    'protocol-viewers'
  ],
  mocha: {
    reporter: "mocha-multi-reporters",
    reporterOptions: {
      reporterEnabled: "spec, mocha-junit-reporter",
    }
  }
}
