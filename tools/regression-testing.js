#!/usr/bin/env node
'use strict';
require('../core-upgrade.js');

var fs = require('fs');
var path = require('path');
var yargs = require('yargs');
var childProcess = require('child_process');

var Promise = require('../lib/utils/promise.js');
var serviceWrapper = require('../tests/serviceWrapper.js');
var rtTest = require('../bin/roundtrip-test.js');

var readFile = Promise.promisify(fs.readFile, false, fs);

var usage = 'Usage: $0 -f <file> -o <sha> -c <sha>';
var opts = yargs.usage(usage, {
	help: {
		description: 'Show this message.',
		'boolean': true,
		'default': false,
		alias: 'h',
	},
	file: {
		description: 'List of pages to test. (format dbname:Title\\n)',
		'boolean': false,
		alias: 'f',
	},
	oracle: {
		description: 'A commit hash to use as the oracle.',
		'boolean': false,
		alias: 'o',
	},
	commit: {
		description: 'A commit hash to test against.',
		'boolean': false,
		'default': 'master',
		alias: 'c',
	},
	// FIXME: Add an option for the regression url.
});

(function() {
	var argv = opts.argv;

	if (argv.help) {
		opts.showHelp();
		return;
	}

	if (!argv.f || !argv.o) {
		console.error('Supplying a commit for the oracle and file is required!\n');
		opts.showHelp();
		return;
	}

	var checkout = Promise.method(function(commit) {
		console.log('Checking out: ' + commit);
		return Promise.promisify(
			childProcess.execFile, ['stdout', 'stderr'], childProcess
		)('git', ['checkout', commit], {
			cwd: path.join(__dirname, '..'),
		});
	});

	var titles;
	var run = Promise.method(function(handleResult) {
		return serviceWrapper.runServices({ skipMock: true }).then(function(ret) {
			// Do this serially for now.
			return Promise.reduce(titles, function(_, t) {
				return rtTest.runTests(t.title, {
					prefix: t.prefix,
					parsoidURL: ret.parsoidURL,
				}, rtTest.jsonFormat).then(
					handleResult.bind(null, t)
				);
			}, null).then(function() {
				return ret.runner.stop();
			});
		});
	});

	var summary = [];
	var compareResult = function(t, results) {
		var oracle = JSON.stringify(t.oresults, null, '\t');
		var commit = JSON.stringify(results, null, '\t');
		console.log(t.prefix, t.title);
		if (commit === oracle) {
			console.log('No changes!');
		} else {
			console.log(argv.o + ' results:', oracle);
			console.log(argv.c + ' results:', commit);
			summary.push(t.prefix + '/' + t.title);
		}
	};

	readFile(argv.f, 'utf8').then(function(data) {
		titles = data.trim().split('\n').map(function(l) {
			var ind = l.indexOf(':');
			return {
				prefix: l.substr(0, ind),
				title: l.substr(ind + 1),
			};
		});
		return checkout(argv.o);
	}).then(function() {
		return run(function(t, ret) {
			if (ret.error) { throw ret.error; }
			t.oresults = ret.results;
		});
	}).then(function() {
		return checkout(argv.c);
	}).then(function() {
		return run(function(t, ret) {
			if (ret.error) { throw ret.error; }
			compareResult(t, ret.results);
		});
	}).then(function() {
		console.log('----------------------------');
		console.log('Pages needing investigation:');
		console.log(summary);
		process.exit(0);
	}).done();
}());
