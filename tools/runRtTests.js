#!/usr/bin/env node
'use strict';

require('../core-upgrade.js');

const fs = require('pn/fs');
const yargs = require('yargs');

const Promise = require('../lib/utils/promise.js');
const serviceWrapper = require('../tests/serviceWrapper.js');
const rtTest = require('../bin/roundtrip-test.js');

const usage = 'Usage: $0 --parsoidURL <url> -f <file>';
const opts = yargs
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
	outfile: {
		description: '(OPTIONAL) Output file to store JSON results blob',
		'boolean': false,
		alias: 'o',
	},
	outputContentVersion: {
		description: '(OPTIONAL) The acceptable content version.',
		boolean: false,
	},
	parsoidURL: {
		description: 'The URL for the Parsoid API',
		boolean: false,
		default: null,
	},
	proxyURL: {
		description: '(OPTIONAL) URL (with protocol and port, if any) for the proxy fronting Parsoid',
		boolean: false,
		default: null,
	},
	// FIXME: Add an option for the regression url.
});

Promise.async(function *() {
	const argv = opts.argv;

	if (argv.help) {
		opts.showHelp();
		return;
	}

	if (!argv.f) {
		console.error('Supplying a file is required!\n');
		opts.showHelp();
		return;
	}

	if (!argv.parsoidURL) {
		console.error('Please provide the API URL of a running Parsoid instance.\n');
		opts.showHelp();
		return;
	}

	const titles = fs.readFileSync(argv.f, 'utf8').trim().split('\n').map(function(l) {
		const ind = l.indexOf(':');
		return {
			prefix: l.substr(0, ind),
			title: l.substr(ind + 1).replace(/ \|.*$/, ''),
		};
	});

	const results = yield Promise.async(function *() {
		// Do this serially for now.
		yield Promise.reduce(titles, function(_, t) {
			let parsoidURLOpts = { baseUrl: argv.parsoidURL };
			if (argv.proxyURL) {
				parsoidURLOpts.proxy = { host: argv.proxyURL };
			}
			return rtTest.runTests(t.title, {
					prefix: t.prefix,
					parsoidURLOpts: parsoidURLOpts,
					outputContentVersion: argv.outputContentVersion,
				}, rtTest.jsonFormat
			)
			.then(function(ret) {
				if (ret.output.error) {
					t.results = {"html2wt":{"error":1},"selser":{"error":1}};
				} else {
					t.results = ret.output.results;
				}
			});
		}, null);
	})();
	if (argv.o) {
		fs.writeFileSync(argv.o, JSON.stringify(titles));
	} else {
		console.error(JSON.stringify(titles));
	}
})().done();
