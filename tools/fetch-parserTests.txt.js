#!/usr/bin/env node
/**
 * Fetch new parserTests.txt from upstream mediawiki/core.
 */
'use strict';
require('../core-upgrade.js');

// UPDATE THESE when upstream mediawiki/core includes new parsoid-relevant tests
// This ensures that our whitelist/blacklist is in sync.
//
// ==> Use "./fetch-parserTests.txt.js --force" to download latest parserTests
//     and update these hashes automatically.
//
// You can use 'sha1sum -b tests/parser/parserTests.txt' to compute this value:
var expectedSHA1 = "4bdc214a83d57881c30c1a18f47fc85957f0059a";
// git log --pretty=oneline -1 tests/parser/parserTests.txt
var latestCommit = "32a2661a56db1be717ce431c67260bbea771558f";

var fs = require('fs');
var path = require('path');
var https = require('https');
var crypto = require('crypto');

var downloadUrl = {
	host: 'raw.githubusercontent.com',
	path: '/wikimedia/mediawiki/COMMIT-SHA/tests/parser/parserTests.txt',
};
var historyUrl = {
	host: 'api.github.com',
	headers: {'user-agent': 'wikimedia-parsoid'},
	path: '/repos/wikimedia/mediawiki/commits?path=tests/parser/parserTests.txt',
};
var DEFAULT_TARGET = __dirname + "/../tests/parserTests.txt";

var computeSHA1 = function(targetName) {
	var existsSync = fs.existsSync || path.existsSync; // node 0.6 compat
	if (!existsSync(targetName)) {
		return "<file not present>";
	}
	var contents = fs.readFileSync(targetName);
	return crypto.createHash('sha1').update(contents).digest('hex').
		toLowerCase();
};

var fetch = function(url, targetName, gitCommit, cb) {
	console.log('Fetching parserTests.txt from mediawiki/core');
	if (gitCommit) {
		url = {
			host: url.host,
			headers: {'user-agent': 'wikimedia-parsoid'},
			path: url.path.replace(/COMMIT-SHA/, gitCommit),
		};
	}
	https.get(url, function(result) {
		var out = fs.createWriteStream(targetName);
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
			} else if (expectedSHA1 !== computeSHA1(targetName)) {
				console.warn('Parsoid expected sha1sum', expectedSHA1,
					'but got', computeSHA1(targetName));
			}
		});
	}).on('error', function(err) {
		console.error(err);
	});
};

var isUpToDate = function(targetName) {
	return (expectedSHA1 === computeSHA1(targetName));
};

var checkAndUpdate = function(targetName) {
	if (!isUpToDate(targetName)) {
		fetch(downloadUrl, targetName, latestCommit);
	}
};

var forceUpdate = function() {
	console.log('Fetching parserTests.txt history from mediawiki/core');
	var downloadCommit, updateHashes;
	var targetName = DEFAULT_TARGET;

	// fetch the history page
	https.get(historyUrl, function(result) {
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
		fetch(downloadUrl, targetName, gitCommit, function() {
			updateHashes(gitCommit, computeSHA1(targetName));
		});
	};

	// now rewrite this file!
	updateHashes = function(gitCommit, fileHash) {
		var contents = fs.
			readFileSync(__filename, 'utf8').
			replace(/^var expectedSHA1 = "[0-9a-f]*";/m,
					"var expectedSHA1 = \"" + fileHash + "\";").
			replace(/^var latestCommit = "[0-9a-f]*";/m,
					"var latestCommit = \"" + gitCommit + "\";");
		fs.writeFileSync(__filename, contents, 'utf8');
		console.log('Updated fetch-parserTests.txt.js');
	};
};

if (typeof module === 'object' && require.main !== module) {
	module.exports = {
		isUpToDate: isUpToDate.bind(null, DEFAULT_TARGET),
		latestCommit: latestCommit,
	};
} else {
	var argv = require('yargs').argv;
	if (argv.force) {
		console.error("Note: We now have our own copy of parserTests.txt, so fetching\n" +
				"parserTests.txt is normally no longer needed.");
		forceUpdate();
	} else {
		checkAndUpdate(DEFAULT_TARGET);
	}
}
