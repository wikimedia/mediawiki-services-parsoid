'use strict';

const fs = require('fs');
const path = require('path');

/* This is a wrapper around the roundtrip testing script */
const serviceWrapper = require('../serviceWrapper.js');
const rtTest = require('../../bin/roundtrip-test.js');

// If we've started a Parsoid server, cache the URL so that subsequent calls
// don't need to start their own.
let parsoidURL = null;

// Read ids from a file and return the first line of the file
function getTestRunId(opts) {
	const testRunIdFile = opts.testRunIdFile || path.resolve(__dirname, 'parsoid.rt-test.ids');
	return fs.readFileSync(testRunIdFile, 'utf-8').split('\n')[0];
}

function _run(test) {
	return rtTest.runTests(test.title, {
		prefix: test.prefix,
		rtTestMode: true,
		parsoidURL: parsoidURL,
	}, rtTest.xmlFormat).then(function(result) {
		return result.output;
	});
}

function runRoundTripTest(config, test) {
	if (!parsoidURL) {
		// If the test run id starts with PHP: we'll
		// run tests with Parsoid/PHP. If not, we'll
		// run tests with Parsoid/JS.
		const testRunId = getTestRunId({});
		if (/^PHP:/.test(testRunId)) {
			parsoidURL = config.parsoidPHPURL;
		} else {
			parsoidURL = config.parsoidURL;
		}
	}
	if (parsoidURL) {
		return _run(test);
	} else {
		// If no Parsoid server was passed, start our own
		return serviceWrapper.runServices({
			skipMock: true,
			parsoidOptions: config.parsoidOptions,
		})
		.then(function(ret) {
			parsoidURL = ret.parsoidURL;
			return _run(test);
		});
	}
}

if (typeof module === 'object') {
	module.exports.runRoundTripTest = runRoundTripTest;
	module.exports.getTestRunId = getTestRunId;
}
