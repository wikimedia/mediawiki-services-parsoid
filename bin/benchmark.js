'use strict';

const fs = require('fs');
const yaml = require('js-yaml');
require('../core-upgrade.js');
const Promise = require('../lib/utils/promise.js');
const request = Promise.promisify(require('request'), true);

// Some semi-arbitrary list of titles
const sampleTitles = [
	{ wiki: 'enwiki', title: 'Main_Page', revid: 917272779 },
	{ wiki: 'enwiki', title: 'Skating', revid: 921619251 },
	{ wiki: 'enwiki', title: 'Hospet', revid: 913341503 },
	{ wiki: 'enwiki', title: 'Hampi', revid: 921528573 },
	{ wiki: 'enwiki', title: 'Berlin', revid: 921687210 },
	{ wiki: 'enwiki', title: 'Barack_Obama', revid: 921752860 },
	{ wiki: 'enwiki', title: 'Max_Planck_Institute_for_Physics', revid: 921775647 },
	{ wiki: 'enwiki', title: 'Architects & Engineers for 9/11 Truth', revid: 921775875 },
	{ wiki: 'itwiki', title: 'Luna', revid: 108284424 },
	{ wiki: 'itwiki', title: 'Metro', revid: 108262882 },
	{ wiki: 'frwiki', title: 'Mulholland_Drive', revid: 149562710 },
	{ wiki: 'frwiki', title: 'Metro', revid: 108262882 },
	{ wiki: 'frwiki', title: 'François_de_La_Tour_du_Pin', revid: 163623032 },
	{ wiki: 'frwiki', title: 'Jason_Bateman', revid: 163623075 },
	{ wiki: 'jawiki', title: '人類学', revid: 74657621 },
	{ wiki: 'jawiki', title: 'パレオ・インディアン', revid: 70817191 },
	{ wiki: 'mediawiki', title: 'Parsoid', revid: 3453996 },
	{ wiki: 'mediawiki', title: 'RESTBase', revid: 2962542 },
	{ wiki: 'mediawiki', title: 'VisualEditor', revid: 3408339 },
	{ wiki: 'dewikivoyage', title: 'Bengaluru', revid: 1224432 },
	{ wiki: 'dewikivoyage', title: 'Kopenhagen', revid: 1240570 },
	{ wiki: 'dewikivoyage', title: 'Stuttgart', revid: 1226146 },
	{ wiki: 'hiwiktionary', title: 'परिवर्णी', revid: 467616 },
	{ wiki: 'hiwiktionary', title: 'चीन', revid: 456648 },
	{ wiki: 'knwikisource', title: 'ಪಂಪಭಾರತ_ಪ್ರಥಮಾಶ್ವಾಸಂ', revid: 170413 },
];

let config = {
	// File with \n-separated json blobs with at least (wiki, title, oldId / revid) properties
	// If domain is provided, it is used, if not wiki is treated as a prefix
	// All other properties are ignored.
	// If this property is null, sampleTitles above is used
	testTitles: null, // '/tmp/logs',
	jsServer: {
		baseURI: 'http://localhost:8142',
		proxy: '',
	},
	phpServer: {
		baseURI: 'http://DOMAIN/w/rest.php',
		proxy: '', // 'http://scandium.eqiad.wmnet:80',
	},
	maxOutstanding: 8,
	maxRequests: 25,
	verbose: true
};

const state = {
	times: [],
	numPendingRequests: 0,
	outStanding: 0
};

function genFullUrls(config, domain, title, revid) {
	const restFragment = `${domain}/v3/page/html/${encodeURIComponent(title)}/${revid}`;
	return {
		js : `${config.jsServer.baseURI}/${restFragment}`,
		php: `${config.phpServer.baseURI.replace(/DOMAIN/, domain)}/${restFragment}`,
	};
}

function prefixToDomain(prefix) {
	if (prefix === 'commonswiki') {
		return 'commons.wikimedia.org';
	}

	if (prefix === 'metawiki') {
		return 'meta.wikimedia.org';
	}

	if (prefix === 'mediawiki' || prefix === 'mediawikiwiki') {
		return 'www.mediawiki.org';
	}

	if (/wiki$/.test(prefix)) {
		return prefix.replace(/wiki$/, '.wikipedia.org');
	}

	const project = [ 'wiktionary', 'wikisource', 'wikivoyage', 'wikibooks', 'wikiquote', 'wikinews', 'wikiversity' ].find(function(p) {
		return prefix.endsWith(p);
	});

	return project ? `${prefix.substr(0, prefix.length - project.length)}.${project}.org` : null;
}

function issueRequest(type, config, proxy, url, finalizer) {
	const httpOptions = {
		method: 'GET',
		headers: { 'User-Agent': 'Parsoid-Test' },
		proxy: proxy,
		// uri: 'http://localhost/wiki/rest.php/localhost/v3/page/html/User:Subbu/3074' // dummy for testing script
		uri: url
	};

	const reqId = state.numPendingRequests;
	if (config.verbose) {
		console.log(`--> ID=${reqId}; URL:${url}; PENDING=${state.numPendingRequests}; OUTSTANDING=${state.outStanding}`);
	}
	state.numPendingRequests--;
	state.outStanding++;
	const startTime = process.hrtime();
	return request(httpOptions)
	.catch(function(error) { console.log("errrorr!" + error); })
	.then(function() {
		state.outStanding--;
		const endTime = process.hrtime();
		const reqTime = Math.round((endTime[0] * 1e9 + endTime[1]) / 1e6 - (startTime[0] * 1e9 + startTime[1]) / 1e6);
		if (config.verbose) {
			console.log(`<-- ID=${reqId}; URL:${url}; TIME=${reqTime}`);
		}
		state.times.push(reqTime);
		if (state.numPendingRequests === 0 && state.outStanding === 0) {
			const res = state.times.reduce((stats, n) => {
				stats.sum += n;
				stats.min = n < stats.min ? n : stats.min;
				stats.max = n > stats.max ? n : stats.max;
				return stats;
			}, { sum: 0, min: 1000000, max: 0 });
			res.avg = res.sum / state.times.length;
			res.median = state.times.sort((a, b) => a - b)[Math.floor(state.times.length / 2)];
			console.log(`${type.toUpperCase()} STATS: ${JSON.stringify(res)}`);
			finalizer();
		}
	});
}

function computeRandomRequestStream(testUrls, config) {
	const numReqs = config.maxRequests;
	const reqs = [];
	const n = testUrls.length;
	for (let i = 0; i < numReqs; i++) {
		// Pick a random url
		reqs.push(testUrls[Math.floor(Math.random() * n)]);
	}
	return reqs;
}

function reset(config) {
	state.times = [];
	state.numPendingRequests = config.maxRequests;
	state.outStanding = 0; // # outstanding reqs
}

function runTests(config, reqStream, type, proxy, finalizer) {
	if (state.numPendingRequests > 0) {
		if (state.outStanding < config.maxOutstanding) {
			issueRequest(type, config, proxy, reqStream[reqStream.length - state.numPendingRequests][type], finalizer);
		}
		setImmediate(() => runTests(config, reqStream, type, proxy, finalizer));
	}
}

// Override default config
if (process.argv.length > 2) {
	config = yaml.load(fs.readFileSync(process.argv[2], 'utf8'));
}

// CLI overrides config
if (process.argv.length > 3) {
	config.maxOutstanding = parseInt(process.argv[3], 10);
}

// CLI overrides config
if (process.argv.length > 4) {
	config.maxRequests = parseInt(process.argv[4], 10);
}

let testUrls;
if (config.testTitles) {
	// Parse production logs and generate test urls
	const logs = fs.readFileSync(config.testTitles, 'utf8');
	const lines = logs.split(/\n/);
	testUrls = [];
	lines.forEach(function(l) {
		if (l) {
			const log = JSON.parse(l);
			const domain = log.domain || prefixToDomain(log.wiki);
			if (domain) {
				testUrls.push(genFullUrls(config, domain, log.title, log.oldId || log.revid));
			}
		}
	});
} else {
	testUrls = [];
	sampleTitles.forEach(function(t) {
		testUrls.push(genFullUrls(config, t.domain || prefixToDomain(t.wiki), t.title, t.revid));
	});
}

const reqStream = computeRandomRequestStream(testUrls, config);
console.log("--- JS tests ---");
reset(config);
runTests(config, reqStream, 'js', config.jsServer.proxy || '', function() {
	console.log("--- PHP tests---");
	reset(config);
	runTests(config,reqStream, 'php', config.phpServer.proxy || '', function() {
		console.log("--- All done---");
		process.exit(0);
	});
});
