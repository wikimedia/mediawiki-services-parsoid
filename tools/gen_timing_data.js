'use strict';

const fs = require('fs');
const path = require('path');
const Promise = require('prfun/wrap')(require('babybird'));
const request = Promise.promisify(require('request'), true);
const yargs = require('yargs');
let purger = null;

const standardOpts = {
	'apiAccessToken': {
		description: 'File containing MW API access token (for --purge)',
		'boolean': false,
		'default': null
	},
	'count': {
		description: 'How many titles to process (default is all)',
		'boolean': false,
		'default': null
	},
	'csv': {
		description: 'Dump timings in CSV format (default is JSON)',
		'boolean': true,
		'default': false
	},
	'help': {
		description: 'Show this help message',
		'boolean': true,
		'default': false,
		alias: 'h'
	},
	'indir': {
		description: 'Input directory for JSON file with titles',
		'boolean': false,
		'default': "./",
	},
	'outdir': {
		description: 'Output directory to dump JSON file with timings',
		'boolean': false,
		'default': "./",
	},
	'purge': {
		description: 'Purge HTML before fetching to trigger fresh parses?',
		'boolean': true,
		'default': false,
	},
	'sleep': {
		description: 'How long to sleep (in ms) between GETs',
		'boolean': false,
		'default': 1000,
	},
	'verbose': {
		description: 'Verbose output',
		'boolean': true,
		'default': false
	},
	'wiki': {
		description: 'Which wiki prefix to use',
		'boolean': false,
		'default': 'enwiki'
	},
};

let argv = null;
let MW_ACCESS_TOKEN = null;
// To get past local caches
const randomQS = (Math.random()).toString(36).substring(7);

function retryingHTTPRequest(retries, requestOptions, delay) {
	delay = delay || 100; // start with 100ms
	requestOptions.headers = requestOptions.headers || {};
	requestOptions.headers['User-Agent'] = requestOptions.headers['User-Agent'] || 'CTT:PerformanceBenchmarker';
	return request(requestOptions)
	.catch(function(error) {
		if (retries--) {
			console.error('HTTP ' + requestOptions.method + ' to \n' +
				(requestOptions.uri || requestOptions.url) + ' failed: ' + error +
				'\nRetrying in ' + (delay / 1000) + ' seconds.');
			return Promise.delay(delay).then(function() {
				return retryingHTTPRequest(retries, requestOptions, delay * 2);
			});
		} else {
			throw error;
		}
	})
	.spread(function(res, body) {
		if (res.statusCode !== 200) {
			let err = 'Got status code: ' +
				res.statusCode + ' for ' +
				(requestOptions.uri || requestOptions.urls);
			if (res.statusCode !== 404) {
				err += '; body: ' + body;
			}
			throw new Error(err);
		}
		return Array.from(arguments);
	});
}

async function fetchHtml(prefix, title, useparsoid) {
	const url = "https://" + prefix.replace(/wiki$/, '') + ".wikipedia.org/wiki/" + title + "?useparsoid=" + useparsoid + `&x=${ randomQS }`;
	await Promise.delay(argv.sleep);
	return await retryingHTTPRequest(2, { uri: url, method: 'GET' });
}

async function fetchTimes(prefix, title, useparsoid) {
	try {
		const res = await fetchHtml(prefix, title, useparsoid);
		const html = res[1];
		const cpuMatch = html.match(/CPU time usage: ([\d\.]+) seconds/);
		const realMatch = html.match(/Real time usage: ([\d\.]+) seconds/);
		if (cpuMatch && realMatch) {
			if (cpuMatch[1] < 0.05) { // Specially mark titles that complete within 50 ms
				return { status: "small", cpu: cpuMatch[1], real: realMatch[1] };
			} else {
				return { status: "ok", cpu: cpuMatch[1], real: realMatch[1] };
			}
		} else {
			// Ex: dewiki doesn't seem to provide parser limit report
			return { status: "missing" };
		}
	} catch (e) {
		return { status: "error" };
	}
}

function jsonToCsv(data) {
	return `${ data.prefix },"${ data.title }",${ data.parsoid.status },${ data.legacy.cpu || '-' },${ data.legacy.real || '-' },${ data.parsoid.cpu || '-' },${ data.parsoid.real || '-' }`;
}

async function processWiki(wiki, count) {
	const indir = path.resolve(process.cwd(), argv.indir);
	const outdir = path.resolve(process.cwd(), argv.outdir);
	const titles = require(indir + "/" + wiki + ".titles.json");
	let n = count || titles.length;
	if (n > titles.length) {
		n = titles.length;
	}
	console.log("processing " + n + " titles from " + wiki);
	const times = [];
	let i = 0;
	for (i = 0; i < n; i++) {
		const prefix = titles[i].prefix;
		const title = titles[i].title;
		const encodedTitle = encodeURIComponent(title.replace(/ /g, '_'));
		if (argv.purge) {
			if (purger === null) {
				// Initialize
				// FIXME: This implicitly assumes this runs in the visual diff repo
				purger = require('./configs/common/cache_purge.adaptor.js');
				if (fs.existsSync(argv.apiAccessToken)) {
					MW_ACCESS_TOKEN = fs.readFileSync(argv.apiAccessToken);
					MW_ACCESS_TOKEN = MW_ACCESS_TOKEN.toString().trim();
				}
			}
			await purger.purgeCache({
				title: title,
				mwAccessToken: MW_ACCESS_TOKEN,
				html1: {
					url: `https://${ prefix.replace(/wiki$/, '') }.wikipedia.org/wiki/${ title }`
				},
			});
		}
		const data = {
			prefix: prefix,
			title: title,
			legacy: await fetchTimes(prefix, encodedTitle, "0"),
			parsoid: await fetchTimes(prefix, encodedTitle, "1")
		};
		if (argv.verbose) {
			console.log(prefix + ":" + title + "=" + JSON.stringify(data));
		} else {
			let char = ".";
			if (data.parsoid.status === "small") {
				char = "S";
			} else if (data.parsoid.status === "missing" ) {
				char = "M";
			} else if (data.parsoid.status === "error" ) {
				char = "E";
			}
			process.stdout.write(char);
		}
		times.push(argv.csv ? jsonToCsv(data) : data);
	}
	if (argv.csv) {
		fs.writeFileSync(outdir + "/"  + wiki + ".timings.csv", times.join("\n"));
	} else {
		fs.writeFileSync(outdir + "/"  + wiki + ".timings.json", JSON.stringify(times));
	}
}

const usageStr = 'Usage: node ' + process.argv[1] + ' [options]';
const opts = yargs.usage(usageStr).options(standardOpts);
if (opts.argv.help) {
	opts.showHelp();
	return null;
}

argv = opts.argv;

processWiki(opts.argv.wiki, opts.argv.count);
