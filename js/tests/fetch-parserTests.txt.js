/**
 * Fetch new parserTests.txt from upstream mediawiki/core.
 */

// UPDATE THESE when upstream mediawiki/core includes new parsoid-relevant tests
// This ensures that our whitelist is in sync.
// You can use 'sha1sum -b tests/parser/parserTests.txt' to compute this value:
var expectedSHA1 = "f1af8c010dd69906e27036d787fbdc36f1067c55";
// git log --pretty=oneline -1 tests/parser/parserTests.txt
var latestCommit = "df27065fd7278c8c0519e1d400b21e88f383daf3";

var fs = require('fs'),
	path = require('path'),
	https = require('https'),
	crypto = require('crypto');

var existsSync = fs.existsSync || path.existsSync; // node 0.6 compat

var url = {
	host: 'gerrit.wikimedia.org',
	path: '/r/gitweb?p=mediawiki/core.git;a=blob_plain;hb=HEAD;f=tests/parser/parserTests.txt'
};
var target_name = __dirname+"/parserTests.txt";

var computeSHA1 = function(target_name) {
	var contents = fs.readFileSync(target_name);
	return crypto.createHash('sha1').update(contents).digest('hex').
		toLowerCase();
};

var fetch = function(url, target_name, gitCommit) {
	console.log('Fetching parserTests.txt from mediawiki/core');
	if (gitCommit) {
		url.path = url.path.replace(/;hb=[^;]+;/, ';hb='+gitCommit+';');
	}
	https.get(url, function(result) {
		var out = fs.createWriteStream(target_name);
		result.on('data', function(data) {
			out.write(data);
		});
		result.on('end', function() {
			if (out) {
				out.end();
				if (expectedSHA1 !== computeSHA1(target_name)) {
					console.warn('Parsoid expected sha1sum', expectedSHA1,
								 'but got', computeSHA1(target_name));
				}
			}
		});
	}).on('error', function(err) {
		console.error(err);
	});
};

var checkAndUpdate = function() {
	if (existsSync(target_name) &&
		expectedSHA1 === computeSHA1(target_name)) {
		return; // a-ok!
	}
	fetch(url, target_name, latestCommit);
};

if (typeof module === 'object' && require.main !== module) {
	module.exports = {
		checkAndUpdate: checkAndUpdate,
		expectedSHA1: expectedSHA1,
		computeSHA1: function() {
			return existsSync(target_name) ? computeSHA1(target_name) :
				"<file not present>";
		}
	};
} else {
	checkAndUpdate();
}
