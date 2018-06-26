#!/usr/bin/env node
/**
 * Fetch new parserTests.txt from upstream mediawiki/core.
 */

'use strict';

require('../core-upgrade.js');

// UPDATE THESE when upstream mediawiki/core includes new parsoid-relevant tests
// This ensures that our whitelist/blacklist is in sync.
//
// ==> Use "./fetch-parserTests.txt.js <target> --force" to download latest
//     parserTests and update these hashes automatically.
//

var fs = require('pn/fs');
var path = require('path');
var https = require('https');
var crypto = require('crypto');

var Promise = require('../lib/utils/promise.js');

var testDir = path.join(__dirname, '../tests/');
var testFilesPath = path.join(testDir, 'parserTests.json');
var testFiles = require(testFilesPath);

var DEFAULT_TARGET = 'parserTests.txt';

var computeSHA1 = Promise.async(function *(targetName) {
	var targetPath = path.join(testDir, targetName);
	if (!(yield fs.exists(targetPath))) {
		return "<file not present>";
	}
	var contents = yield fs.readFile(targetPath);
	return crypto.createHash('sha1').update(contents).digest('hex')
		.toLowerCase();
});

var fetch = function(targetName, gitCommit, skipCheck) {
	var file = testFiles[targetName];
	var filePath = file.repo + (gitCommit || file.latestCommit) + '/' + file.path;

	console.log('Fetching ' + targetName + ' history from ' + filePath);

	var url = {
		host: 'raw.githubusercontent.com',
		path: filePath,
		headers: { 'user-agent': 'wikimedia-parsoid' },
	};
	return new Promise(function(resolve, reject) {
		https.get(url, function(result) {
			var targetPath = path.join(testDir, targetName);
			var out = fs.createWriteStream(targetPath);
			result.on('data', function(data) {
				out.write(data);
			});
			result.on('end', function() {
				out.end();
				out.destroySoon();
			});
			out.on('close', resolve);
		}).on('error', function(err) {
			console.error(err);
			reject(err);
		});
	}).then(Promise.async(function *() {
		if (!skipCheck) {
			var sha1 = yield computeSHA1(targetName);
			if (file.expectedSHA1 !== sha1) {
				console.warn(
					'Parsoid expected sha1sum', file.expectedSHA1,
					'but got', sha1
				);
			}
		}
	}));
};

var isUpToDate = Promise.async(function *(targetName) {
	var expectedSHA1 = testFiles[targetName].expectedSHA1;
	return (expectedSHA1 === (yield computeSHA1(targetName)));
});

var checkAndUpdate = Promise.async(function *(targetName) {
	if (!(yield isUpToDate(targetName))) {
		yield fetch(targetName);
	}
});

var forceUpdate = Promise.async(function *(targetName) {
	var file = testFiles[targetName];
	var filePath = '/repos' + file.repo + 'commits?path=' + file.path;

	console.log('Fetching ' + targetName + ' history from ' + filePath);

	// fetch the history page
	var url = {
		host: 'api.github.com',
		path: filePath,
		headers: { 'user-agent': 'wikimedia-parsoid' },
	};
	var gitCommit = JSON.parse(yield new Promise(function(resolve, reject) {
		https.get(url, function(result) {
			var res = '';
			result.setEncoding('utf8');
			result.on('data', function(data) { res += data; });
			result.on('end', function() { resolve(res); });
		}).on('error', function(err) {
			console.error(err);
			reject(err);
		});
	}))[0].sha;

	// download latest file
	yield fetch(targetName, gitCommit, true);
	var fileHash = yield computeSHA1(targetName);

	// now rewrite this file!
	file.expectedSHA1 = fileHash;
	file.latestCommit = gitCommit;
	yield fs.writeFile(testFilesPath, JSON.stringify(testFiles, null, '\t'), 'utf8');
	console.log('Updated', testFilesPath);
});

Promise.async(function *() {
	var argv = require('yargs').argv;
	var targetName = argv._.length ? argv._[0] : DEFAULT_TARGET;

	if (!testFiles.hasOwnProperty(targetName)) {
		console.warn(targetName + ' not defined in parserTests.json');
		return;
	}

	if (argv.force) {
		yield forceUpdate(targetName);
	} else {
		yield checkAndUpdate(targetName);
	}
})().done();
