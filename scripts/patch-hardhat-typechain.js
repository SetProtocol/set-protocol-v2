const replace = require('replace-in-file');

let changedFiles;

// Step 1: Replace all exports of classes to be declarations and to change to regular .ts files
const options1 = {
  //Glob(s)
  files: [
    './node_modules/hardhat-typechain/dist/src/index.js',
  ],

  //Replacement to make (string or regex)
  from: /\$\{config.paths.artifacts\}\/\!\(build-info\)\//g,
  to: '{${config.paths.artifacts},external}/!(build-info)/',
};

try {
  changedFiles = replace.sync(options1);
  console.log('Patching hardhat-typechain file.');
}
catch (error) {
  console.error('Error occurred:', error);
}