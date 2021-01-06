const replace = require('replace-in-file');

let changedFiles;

// Step 1: Replace all exports of classes to be declarations and to change to regular .ts files
const options1 = {
  //Glob(s)
  files: [
    './typechain/*.d.ts',
  ],

  //Replacement to make (string or regex)
  from: /export class/g,
  to: 'export declare class',
};

try {
  changedFiles = replace.sync(options1);
  console.log('Step 1. Typechain fixing modified files:', changedFiles.map(f => f.file.toString()).join(', '));
}
catch (error) {
  console.error('Error occurred:', error);
}

// Step 2: Replace all ethers.utils.Interface with just Interface
const options2 = {
  //Glob(s)
  files: [
    './typechain/*.ts',
  ],

  //Replacement to make (string or regex)
  from: /ethers\.utils\.Interface/g,
  to: 'Interface',
};

try {
  changedFiles = replace.sync(options2);
  console.log('Step 2. Typechain fixing modified files:', changedFiles.map(f => f.file.toString()).join(', '));
}
catch (error) {
  console.error('Error occurred:', error);
}

// Step 3: Fix import of Interface to come from @ethersproject/abi
const options3 = {
  //Glob(s)
  files: [
    './typechain/*.ts',
  ],

  //Replacement to make (string or regex)
  from: /import { FunctionFragment, EventFragment, Result } from \"@ethersproject\/abi\"/g,
  to: 'import { FunctionFragment, EventFragment, Result, Interface } from "@ethersproject/abi"',
};


try {
  changedFiles = replace.sync(options3);
  console.log('Step 3. Typechain fixing modified files:', changedFiles.map(f => f.file.toString()).join(', '));
}
catch (error) {
  console.error('Error occurred:', error);
}


// Step 4: Fix gas to be string instead of number
const options4 = {
  //Glob(s)
  files: [
    './typechain/**/*.ts',
  ],

  //Replacement to make (string or regex)
  from: /gas\: [0-9]+,/g,
  to: (match) => match.replace(/gas: ([0-9]+),/g, 'gas: "$1",'),
};

try {
  changedFiles = replace.sync(options4);
  console.log('Step 4. Typechain fixing modified files:', changedFiles.map(f => f.file.toString()).join(', '));
}
catch (error) {
  console.error('Error occurred:', error);
}