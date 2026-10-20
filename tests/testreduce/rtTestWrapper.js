'use strict';

const fs = require('fs');
const path = require('path');

/* This is a wrapper around the roundtrip testing script */
const rtTest = require('../../bin/roundtrip-test.js');
const yaml = require('js-yaml');

// Read ids from a file and return the first line of the file
function getTestRunId(opts) {
	const testRunIdFile = opts.testRunIdFile || path.resolve(__dirname, 'parsoid.rt-test.ids');
	return fs.readFileSync(testRunIdFile, 'utf-8').split('\n')[0];
}

// Read the mw-parsoid datacenter (eqiad/codfw) written by bin/start-rt-test.sh,
// or null if there is none.
function getDatacenter(opts) {
	const dcFile = opts.datacenterFile || path.resolve(__dirname, 'parsoid.rt-test.datacenter');
	if (!fs.existsSync(dcFile)) {
		return null;
	}
	return fs.readFileSync(dcFile, 'utf-8').split('\n')[0].trim() || null;
}

// Route requests to mw-parsoid in the chosen datacenter, overriding any
// X-Wikimedia-Debug header in the client config.
function getParsoidURLOpts(config) {
	const dc = getDatacenter(config);
	if (!dc) {
		return config.parsoidPHP;
	}
	const headers = Object.assign({}, config.parsoidPHP.headers);
	Object.keys(headers).forEach(function(h) {
		if (h.toLowerCase() === 'x-wikimedia-debug') {
			delete headers[h];
		}
	});
	headers['X-Wikimedia-Debug'] = 'k8s-mw-parsoid-' + dc;
	return Object.assign({}, config.parsoidPHP, { headers });
}

function runRoundTripTest(config, test) {
	return rtTest.runTests(test.title, {
		prefix: test.prefix,
		parsoidURLOpts: getParsoidURLOpts(config),
	}, rtTest.xmlFormat).then(function(result) {
		return result.output;
	});
}

if (typeof module === 'object') {
	module.exports.runRoundTripTest = runRoundTripTest;
	module.exports.getTestRunId = getTestRunId;
}
