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

var fs = require('fs');
var path = require('path');
var https = require('https');
var crypto = require('crypto');

var testDir = path.join(__dirname, '../tests/');
var testFilesPath = path.join(testDir, 'parserTests.json');
var testFiles = require(testFilesPath);

var DEFAULT_TARGET = 'parserTests.txt';

var computeSHA1 = function(targetName) {
	var targetPath = path.join(testDir, targetName);
	if (!fs.existsSync(targetPath)) {
		return "<file not present>";
	}
	var contents = fs.readFileSync(targetPath);
	return crypto.createHash('sha1').update(contents).digest('hex').
		toLowerCase();
};

var fetch = function(targetName, gitCommit, cb) {
	console.log('Fetching parserTests.txt from mediawiki/core');
	var file = testFiles[targetName];
	var url = {
		host: 'raw.githubusercontent.com',
		path: file.repo + (gitCommit || file.latestCommit) + '/' + file.path,
		headers: { 'user-agent': 'wikimedia-parsoid' },
	};
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
		out.on('close', function() {
			if (cb) {
				return cb();
			} else if (file.expectedSHA1 !== computeSHA1(targetName)) {
				console.warn('Parsoid expected sha1sum', file.expectedSHA1,
					'but got', computeSHA1(targetName));
			}
		});
	}).on('error', function(err) {
		console.error(err);
	});
};

var isUpToDate = function(targetName) {
	var expectedSHA1 = testFiles[targetName].expectedSHA1;
	return (expectedSHA1 === computeSHA1(targetName));
};

var checkAndUpdate = function(targetName) {
	if (!isUpToDate(targetName)) {
		fetch(targetName);
	}
};

var forceUpdate = function(targetName) {
	console.log('Fetching parserTests.txt history from mediawiki/core');
	var downloadCommit, updateHashes;
	var file = testFiles[targetName];

	// fetch the history page
	var url = {
		host: 'api.github.com',
		path: '/repos' + file.repo + 'commits?path=' + file.path,
		headers: { 'user-agent': 'wikimedia-parsoid' },
	};
	https.get(url, function(result) {
		var res = '';
		result.setEncoding('utf8');
		result.on('data', function(data) { res += data; });
		result.on('end', function() {
			downloadCommit(JSON.parse(res)[0].sha);
		});
	}).on('error', function(err) {
		console.error(err);
	});

	// download latest file
	downloadCommit = function(gitCommit) {
		fetch(targetName, gitCommit, function() {
			updateHashes(gitCommit, computeSHA1(targetName));
		});
	};

	// now rewrite this file!
	updateHashes = function(gitCommit, fileHash) {
		file.expectedSHA1 = fileHash;
		file.latestCommit = gitCommit;
		fs.writeFileSync(testFilesPath, JSON.stringify(testFiles, null, '\t'), 'utf8');
		console.log('Updated fetch-parserTests.txt.js');
	};
};

(function() {
	var argv = require('yargs').argv;
	var targetName = argv._.length ? argv._[0] : DEFAULT_TARGET;

	if (!testFiles.hasOwnProperty(targetName)) {
		console.warn(targetName + ' not defined in parserTests.json');
		return;
	}

	if (argv.force) {
		forceUpdate(targetName);
	} else {
		checkAndUpdate(targetName);
	}
}());
