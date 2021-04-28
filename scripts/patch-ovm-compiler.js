const replace = require('replace-in-file');

let changedFiles;

// Step 1: Fix a bug in optimism plugin where empty compilation jobs trigger
//         "No input sources specified" error.
const options1 = {
  //Glob(s)
  files: [
    './node_modules/@eth-optimism/plugins/hardhat/compiler/index.js',
  ],

  //Replacement to make (string or regex)
  from: /\/\/ Build both inputs separately\./g,
  to: 'if (Object.keys(ovmInput.sources).length === 0) return {};',
};

try {
  changedFiles = replace.sync(options1);
  console.log('Patching eth-optimism hardhat plugin compiler file.');
}
catch (error) {
  console.error('Error occurred:', error);
}