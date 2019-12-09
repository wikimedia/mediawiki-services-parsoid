#!/usr/bin/env node

'use strict';

require('../core-upgrade.js');

var fs = require('pn/fs');
var path = require('path');
var yargs = require('yargs');
var childProcess = require('pn/child_process');

var Promise = require('../lib/utils/promise.js');
var serviceWrapper = require('../tests/serviceWrapper.js');
var rtTest = require('../bin/roundtrip-test.js');

var usage = 'Usage: $0 -f <file> -o <sha> -c <sha>';
var opts = yargs
.usage(usage)
.options({
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
	outputContentVersion: {
		description: 'The acceptable content version.',
		boolean: false,
	},
	semanticOnly: {
		boolean: false,
	},
	parsoidURL: {
		description: 'The URL for the Parsoid API',
		boolean: false,
		default: '',
	},
	proxyURL: {
		description: 'URL (with protocol and port, if any) for the proxy fronting Parsoid',
		boolean: false,
		default: null,
	},
	// FIXME: Add an option for the regression url.
});

Promise.async(function *() {
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

	var checkout = Promise.async(function *(commit) {
		console.log('Checking out: ' + commit);
		yield childProcess.execFile('git', ['checkout', commit], {
			cwd: path.join(__dirname, '..'),
		}).promise;
	});
	var titles;
	var run = Promise.async(function *(handleResult) {
		var obj;
		if (argv.parsoidURL) {
			obj = { parsoidURL: argv.parsoidURL };
		} else {
			obj = yield serviceWrapper.runServices({ skipMock: true });
		}
		// Do this serially for now.
		yield Promise.reduce(titles, function(_, t) {
			var parsoidURLOpts = { baseUrl: obj.parsoidURL };
			if (argv.proxyURL) {
				parsoidURLOpts.proxy = { host: argv.proxyURL };
			}
			return rtTest.runTests(t.title, {
				prefix: t.prefix,
				parsoidURLOpts: parsoidURLOpts,
				outputContentVersion: argv.outputContentVersion,
			}, rtTest.jsonFormat).then(
				ret => handleResult(t, ret)
			);
		}, null);
		if (!argv.parsoidURL) {
			yield obj.runner.stop();
		}
	});

	var trimSyntactic = function(r) {
		if (argv.semanticOnly) {
			Object.keys(r).forEach((k) => { r[k].syntactic = undefined; });
		}
		return r;
	};

	var summary = [];
	var compareResult = function(t, results) {
		var oracle = JSON.stringify(trimSyntactic(t.oresults), null, '\t');
		var commit = JSON.stringify(trimSyntactic(results), null, '\t');
		console.log(t.prefix, t.title);
		if (commit === oracle) {
			console.log('No changes!');
		} else {
			console.log(argv.o + ' results:', oracle);
			console.log(argv.c + ' results:', commit);
			summary.push(t.prefix + '/' + t.title);
		}
	};

	var data = yield fs.readFile(argv.f, 'utf8');
	titles = data.trim().split('\n').map(function(l) {
		var ind = l.indexOf(':');
		return {
			prefix: l.substr(0, ind),
			title: l.substr(ind + 1).replace(/ \|.*$/, ''),
		};
	});
	yield checkout(argv.o);
	yield run(function(t, ret) {
		if (ret.output.error) { throw ret.output.error; }
		t.oresults = ret.output.results;
	});
	yield checkout(argv.c);
	yield run(function(t, ret) {
		if (ret.output.error) { throw ret.output.error; }
		compareResult(t, ret.output.results);
	});
	console.log('----------------------------');
	console.log('Pages needing investigation:');
	console.log(summary);
})().done();
