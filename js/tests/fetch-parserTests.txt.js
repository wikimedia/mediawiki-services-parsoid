#!/usr/bin/env node
/**
 * Fetch new parserTests.txt from upstream mediawiki/core.
 */

// UPDATE THESE when upstream mediawiki/core includes new parsoid-relevant tests
// This ensures that our whitelist/blacklist is in sync.
//
// ==> Use "./fetch-parserTests.txt.js --force" to download latest parserTests
//     and update these hashes automatically.
//
// You can use 'sha1sum -b tests/parser/parserTests.txt' to compute this value:
var expectedSHA1 = "19f1c3446841b04b26ede0db128b892bba969027";
// git log --pretty=oneline -1 tests/parser/parserTests.txt
var latestCommit = "bd9f08424fac898601c1fca0402c4d8b98b45563";

var fs = require('fs'),
	path = require('path'),
	https = require('https'),
	crypto = require('crypto');

var downloadUrl = {
	host: 'gerrit.wikimedia.org',
	path: '/r/gitweb?p=mediawiki/core.git;a=blob_plain;hb=HEAD;f=tests/parser/parserTests.txt'
};
var historyUrl = {
	host: downloadUrl.host,
	path: '/r/gitweb?p=mediawiki/core.git;a=history;hb=HEAD;f=tests/parser/parserTests.txt'
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
			path: url.path.replace(/;hb=[^;]+;/, ';hb='+gitCommit+';')
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
		// remove everything before <table class="history">
		html = html.replace(/^[^]*<table\s[^>]*class="history"[^>]*>/, '');
		// now find the first link to this file with a specific hash
		var m = /[?;]a=blob;f=tests\/parser\/parserTests.txt;hb=([0-9a-f]+)/.
			exec(html);
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
		isUpToDate: isUpToDate
	};
} else {
	var argv = require('optimist').argv;
	if (argv.force) {
		forceUpdate();
	} else {
		checkAndUpdate();
	}
}
