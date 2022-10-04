#!/usr/bin/env node
/**
 * Fetch new parserTests.txt from upstream mediawiki/core.
 */

'use strict';

require('../core-upgrade.js');

// UPDATE THESE when upstream mediawiki/core includes new parsoid-relevant tests
// This ensures that our knownFailures list is in sync.
//
// ==> Use "./fetch-parserTests.txt.js <target> --force" to download latest
//     parserTests and update these hashes automatically.
//

const fs = require('pn/fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const Buffer = require('buffer').Buffer;

const Promise = require('../lib/utils/promise.js');

const testDir = path.join(__dirname, '../tests/parser/');
const testFilesPath = path.join(testDir, '../parserTests.json');
const testFiles = require(testFilesPath);

const DEFAULT_TARGET = 'parserTests.txt';

const computeSHA1 = Promise.async(function *(targetName) {
	const targetPath = path.join(testDir, targetName);
	if (!(yield fs.exists(targetPath))) {
		return "<file not present>";
	}
	const contents = yield fs.readFile(targetPath);
	return crypto.createHash('sha1').update(contents).digest('hex')
		.toLowerCase();
});

const fetch = function(targetName, gitCommit, skipCheck) {
	const file = testFiles[targetName];
	const filePath = '/r/plugins/gitiles' + file.repo + '+/' + (gitCommit || file.latestCommit) + '/' + file.path + '?format=TEXT';

	console.log('Fetching ' + targetName + ' history from ' + filePath);

	const url = {
		host: 'gerrit.wikimedia.org',
		path: filePath,
		headers: { 'user-agent': 'wikimedia-parsoid' },
	};
	return new Promise(function(resolve, reject) {
		https.get(url, function(result) {
			const targetPath = path.join(testDir, targetName);
			const out = fs.createWriteStream(targetPath);
			const rs = [];
			result.on('data', function(data) {
				rs.push(data);
			});
			result.on('end', function() {
				// Gitiles raw files are base64 encoded
				out.write(Buffer.from(rs.join(''), 'base64'));
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
			const sha1 = yield computeSHA1(targetName);
			if (file.expectedSHA1 !== sha1) {
				console.warn(
					'Parsoid expected sha1sum', file.expectedSHA1,
					'but got', sha1
				);
			}
		}
	}));
};

const isUpToDate = Promise.async(function *(targetName) {
	const expectedSHA1 = testFiles[targetName].expectedSHA1;
	return (expectedSHA1 === (yield computeSHA1(targetName)));
});

const checkAndUpdate = Promise.async(function *(targetName) {
	if (!(yield isUpToDate(targetName))) {
		yield fetch(targetName);
	}
});

const forceUpdate = Promise.async(function *(targetName) {
	const file = testFiles[targetName];
	const filePath = '/r/plugins/gitiles' + file.repo + '+log/refs/heads/master/' + file.path + '?format=JSON';
	console.log('Fetching ' + targetName + ' history from ' + filePath);

	// fetch the history page
	const url = {
		host: 'gerrit.wikimedia.org',
		path: filePath,
		headers: { 'user-agent': 'wikimedia-parsoid' },
	};
	const gitCommit = JSON.parse(yield new Promise(function(resolve, reject) {
		https.get(url, function(result) {
			var res = '';
			result.setEncoding('utf8');
			result.on('data', function(data) { res += data; });
			// The slice on the result is because gitiles is returning
			// JSON starting with extraneous characters, ")]}'\n"
			result.on('end', function() { resolve(res.slice(5)); });
		}).on('error', function(err) {
			console.error(err);
			reject(err);
		});
	})).log[0].commit;

	// download latest file
	yield fetch(targetName, gitCommit, true);
	const fileHash = yield computeSHA1(targetName);

	// now rewrite this file!
	file.expectedSHA1 = fileHash;
	file.latestCommit = gitCommit;
	yield fs.writeFile(testFilesPath, JSON.stringify(testFiles, null, '\t'), 'utf8');
	console.log('Updated', testFilesPath);
});

Promise.async(function *() {
	const argv = require('yargs').argv;
	const targetName = argv._.length ? argv._[0] : DEFAULT_TARGET;

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
