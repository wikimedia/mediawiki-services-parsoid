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

const computeSHA1 = Promise.async(function *(targetName) {
	const targetPath = path.join(testDir, targetName);
	if (!(yield fs.exists(targetPath))) {
		return "<file not present>";
	}
	const contents = yield fs.readFile(targetPath);
	return crypto.createHash('sha1').update(contents).digest('hex')
		.toLowerCase();
});

const fetch = async function(repo, testFile, gitCommit, skipCheck) {
	const repoInfo = testFiles[repo];
	const targets = repoInfo.targets;
	for (const targetName in targets) {
		if (testFile && (testFile !== targetName)) {
			continue;
		}

		const file = targets[targetName];
		const filePath = '/r/plugins/gitiles/' + testFiles[repo].project + '/+/' + (gitCommit || repoInfo.latestCommit) + '/' + file.path + '?format=TEXT';

		console.log('Fetching ' + targetName + ' history from ' + filePath);

		const url = {
			host: 'gerrit.wikimedia.org',
			path: filePath,
			headers: { 'user-agent': 'wikimedia-parsoid' },
		};
		await new Promise(function(resolve, reject) {
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
	}
};

const isUpToDate = Promise.async(function *(targetRepo) {
	const repoInfo = testFiles[targetRepo];
	const targets = repoInfo.targets;
	for (const targetName in targets) {
		const expectedSHA1 = targets[targetName].expectedSHA1;
		if (expectedSHA1 !== (yield computeSHA1(targetName))) {
			return false;
		}
	}
	return true;
});

const forceUpdate = Promise.async(function *(targetRepo) {
	const repoInfo = testFiles[targetRepo];
	const gerritPath = '/r/plugins/gitiles/' + repoInfo.project + '/+log/refs/heads/master' + '?format=JSON';
	console.log('Fetching ' + targetRepo + ' history from ' + gerritPath);

	// fetch the history page
	const url = {
		host: 'gerrit.wikimedia.org',
		path: gerritPath,
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

	const targets = repoInfo.targets;
	for (const targetName in targets) {
		// download latest file
		yield fetch(targetRepo, targetName, gitCommit, true);
		const fileHash = yield computeSHA1(targetName);

		// now rewrite this file!
		targets[targetName].expectedSHA1 = fileHash;
	}
	repoInfo.latestCommit = gitCommit;
	yield fs.writeFile(testFilesPath, JSON.stringify(testFiles, null, '\t') + '\n', 'utf8');
	console.log('Updated', testFilesPath);
});

Promise.async(function *() {
	const usage = 'Usage: $0 <repo-key-from-parserTests.json>';
	const yargs = require('yargs');
	const opts = yargs
	.usage(usage)
	.options({
		'help': { description: 'Show this message' },
	});
	const argv = opts.argv;
	if (argv.help || argv._.length !== 1) {
		opts.showHelp();
		return;
	}
	const targetRepo = argv._[0];
	if (!testFiles.hasOwnProperty(targetRepo)) {
		console.warn(targetRepo + ' not defined in parserTests.json');
		return;
	}
	if (targetRepo === 'parsoid') {
		console.warn('Nothing to sync for parsoid files');
		return;
	}
	if (yield isUpToDate(targetRepo)) {
		console.warn("Files not locally modified.");
	}

	if (argv.force) {
		// Allow this for back-compat, but we don't need this argument
		// any more.
	}
	yield forceUpdate(targetRepo);
})().done();
