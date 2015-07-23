#!/usr/bin/env node
var fs = require('fs');

var filename = process.argv[2];

var titles = fs.readFileSync(filename, 'utf8').split(/[\n\r]+/);
console.assert(titles.pop() === ''); // trailing newline.

console.log(JSON.stringify(titles, null, '\t'));
