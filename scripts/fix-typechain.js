const replace = require('replace-in-file');

const options = {
  //Glob(s)
  files: [
    './typechain/*.d.ts',
  ],

  //Replacement to make (string or regex)
  from: /export class/g,
  to: 'export declare class',
};

try {
  let changedFiles = replace.sync(options);
  console.log('Modified files:', changedFiles.map(f => f.file.toString()).join(', '));
}
catch (error) {
  console.error('Error occurred:', error);
}
