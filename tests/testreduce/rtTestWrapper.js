'use strict';

/* This is a wrapper around the roundtrip testing script */
var apiServer = require('../apiServer.js');
var rtTest = require('../../bin/roundtrip-test.js');

var parsoidConfig = null;
var parsoidURL = null;

var _run = function(test) {
	return rtTest.runTests(test.title, {
		setup: require(parsoidConfig).setup,
		prefix: test.prefix,
		rtTestMode: true,
		parsoidURL: parsoidURL,
	}, rtTest.xmlFormat);
};

var runRoundTripTest = function(config, test) {
	parsoidURL = config.parsoidURL;
	parsoidConfig = config.parsoidConfig;

	if (parsoidURL) {
		return _run(test);
	} else {
		// If no Parsoid server was passed, start our own
		var p = apiServer.startParsoidServer({
			serverArgv: [
				// We want the cluster master so that timeouts on stuck titles
				// lead to a restart.
				'--num-workers', '1',
				'--config', parsoidConfig,
			],
			quiet: true,
		}).then(function(ret) {
			config.parsoidURL = parsoidURL = ret.url;
			return _run(test);
		});
		apiServer.exitOnProcessTerm();
		return p;
	}
};

if (typeof module === 'object') {
	module.exports.runRoundTripTest = runRoundTripTest;
}
