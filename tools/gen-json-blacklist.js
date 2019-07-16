#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');
const testDir = path.join(__dirname, '../tests/');
const testFiles = require(testDir + 'parserTests.json');

Object.keys(testFiles).forEach(function(t) {
	const blFile = path.join(testDir, t.replace('.txt', '-php-blacklist.js'));
	if (!fs.exists(blFile)) {
		// Copy to PHP version
		fs.writeFileSync(blFile, fs.readFileSync(blFile.replace('-php', ''), 'utf8'));
	}
	// JS -> JSON
	const blStr = JSON.stringify(require(blFile));
	fs.writeFileSync(blFile.replace("-blacklist.js", "-blacklist.json"), blStr);
});
