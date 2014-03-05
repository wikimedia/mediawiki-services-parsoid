#!/usr/bin/env node
/**
 * Fetch new parserTests.txt from upstream mediawiki/core.
 */
"use strict";

// UPDATE THESE when upstream mediawiki/core includes new parsoid-relevant tests
// This ensures that our whitelist/blacklist is in sync.
//
// ==> Use "./fetch-parserTests.txt.js --force" to download latest parserTests
//     and update these hashes automatically.
//
// You can use 'sha1sum -b tests/parser/parserTests.txt' to compute this value:
var expectedSHA1 = "5a4cc734945349d141e33d044148b0cd578935c2";
// git log --pretty=oneline -1 tests/parser/parserTests.txt
var latestCommit = "0e0ffe4d17b2aea1a2da1fadc46e08b07708fe79";

var fs = require('fs'),
	path = require('path'),
	https = require('https'),
	crypto = require('crypto');

var downloadUrl = {
	host: 'git.wikimedia.org',
	path: '/raw/mediawiki%2Fcore.git/COMMIT-SHA/tests%2Fparser%2FparserTests.txt'
};
var historyUrl = {
	host: downloadUrl.host,
	path: '/history/mediawiki%2Fcore.git/HEAD/tests%2Fparser%2FparserTests.txt'
};
var target_name = __dirname+"/parserTests.txt";

var computeSHA1 = function(target_name) {
	var existsSync = fs.existsSync || path.existsSync; // node 0.6 compat
	if (!existsSync(target_name)) {
		return "<file not present>";
	}
	var contents = fs.readFileSync(target_name);
	return crypto.createHash('sha1').update(contents).digest('hex').
		toLowerCase();
};

var fetch = function(url, target_name, gitCommit, cb) {
	console.log('Fetching parserTests.txt from mediawiki/core');
	if (gitCommit) {
		url = {
			host: url.host,
			path: url.path.replace(/COMMIT-SHA/, gitCommit)
		};
	}
	https.get(url, function(result) {
		var out = fs.createWriteStream(target_name);
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
			} else if (expectedSHA1 !== computeSHA1(target_name)) {
				console.warn('Parsoid expected sha1sum', expectedSHA1,
							 'but got', computeSHA1(target_name));
			}
		});
	}).on('error', function(err) {
		console.error(err);
	});
};

var isUpToDate = function() {
	return (expectedSHA1 === computeSHA1(target_name));
};

var checkAndUpdate = function() {
	if (!isUpToDate()) {
		fetch(downloadUrl, target_name, latestCommit);
	}
};

var forceUpdate = function() {
	console.log('Fetching parserTests.txt history from mediawiki/core');
	var findMostRecentCommit, downloadCommit, updateHashes;

	// fetch the history page
	https.get(historyUrl, function(result) {
		var html = '';
		result.setEncoding('utf8');
		result.on('data', function(data) { html += data; });
		result.on('end', function() {
			findMostRecentCommit(html);
		});
	}).on('error', function(err) {
		console.error(err);
	});

	// now look for the most recent commit
	findMostRecentCommit = function(html) {
		// remove everything before <table class="pretty">
		html = html.replace(/^[^]*<table\s*class=\\"pretty\\">/, '');
		// now find the first link to this file with a specific hash
		var m = /core.git\/([0-9a-f]+)\/tests%2Fparser%2FparserTests.txt/.exec(html);
		var gitCommit = m ? m[1] : "HEAD";
		downloadCommit(gitCommit);
	};

	// download latest file
	downloadCommit = function(gitCommit) {
		fetch(downloadUrl, target_name, gitCommit, function() {
			updateHashes(gitCommit, computeSHA1(target_name));
		});
	};

	// now rewrite this file!
	updateHashes = function(gitCommit, fileHash) {
		var contents = fs.
			readFileSync(__filename, 'utf8').
			replace(/^var expectedSHA1 = "[0-9a-f]*";/m,
					"var expectedSHA1 = \""+fileHash+"\";").
			replace(/^var latestCommit = "[0-9a-f]*";/m,
					"var latestCommit = \""+gitCommit+"\";");
		fs.writeFileSync(__filename, contents, 'utf8');
		console.log('Updated fetch-parserTests.txt.js');
	};
};

if (typeof module === 'object' && require.main !== module) {
	module.exports = {
		checkAndUpdate: checkAndUpdate,
		isUpToDate: isUpToDate,
		latestCommit: latestCommit
	};
} else {
	var argv = require('optimist').argv;
	if (argv.force) {
		console.error( "Note: We now have our own copy of parserTests.txt, so fetching\n" +
				"parserTests.txt is normally no longer needed." );
		forceUpdate();
	} else {
		checkAndUpdate();
	}
}
