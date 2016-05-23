'use strict';

/* This is a wrapper around the roundtrip testing script */
var serviceWrapper = require('../serviceWrapper.js');
var rtTest = require('../../bin/roundtrip-test.js');

// If we've started a Parsoid server, cache the URL so that subsequent calls
// don't need to start their own.
var parsoidURL = null;

var _run = function(test) {
	return rtTest.runTests(test.title, {
		prefix: test.prefix,
		rtTestMode: true,
		parsoidURL: parsoidURL,
	}, rtTest.xmlFormat);
};

var runRoundTripTest = function(config, test) {
	parsoidURL = parsoidURL || config.parsoidURL;
	if (parsoidURL) {
		return _run(test);
	} else {
		// If no Parsoid server was passed, start our own
		return serviceWrapper.runServices({
			skipMock: true,
			localsettings: config.parsoidConfig,
		}).then(function(ret) {
			parsoidURL = ret.parsoidURL;
			return _run(test);
		});
	}
};

if (typeof module === 'object') {
	module.exports.runRoundTripTest = runRoundTripTest;
}
