#!/usr/bin/env node

'use strict';

require('../core-upgrade.js');
var fs = require('pn/fs');

var Promise = require('../lib/utils/promise.js');
var ScriptUtils = require('./ScriptUtils.js').ScriptUtils;

var wikis = [
	{ prefix: 'enwiki', nowiki: 'nowiki added' },
	{ prefix: 'frwiki', nowiki: 'nowiki' },
	{ prefix: 'itwiki', nowiki: 'nowiki' },
	{ prefix: 'hewiki', nowiki: 'nowiki' },
	// We need to figure out what the nowiki tag filter
	// is for these wikis and update them here.
	// { prefix: 'ruwiki', nowiki: 'nowiki' },
	// { prefix: 'plwiki', nowiki: 'nowiki' },
	// { prefix: 'ptwiki', nowiki: 'nowiki' },
	// { prefix: 'eswiki', nowiki: 'nowiki' },
	// { prefix: 'nlwiki', nowiki: 'nowiki' },
	// { prefix: 'dewiki', nowiki: 'nowiki' },
];

var fetchAll;

var processRes = Promise.async(function *(fetchArgs, out, body) {
	// Accum titles
	body = JSON.parse(body);
	var stats = fetchArgs.wiki.stats;
	Array.from(body.query ? body.query.recentchanges : []).reduce((titles, e) => {
		// If it is a VE edit, grab it!
		if (e.tags.indexOf('visualeditor') >= 0) {
			var date = e.timestamp.replace(/T.*$/, '');
			if (!stats[date]) {
				stats[date] = 0;
			}
			stats[date] += 1;
			titles.push("DATE: " + e.timestamp + "; DIFF: " + fetchArgs.apiURI.replace(/api.php/, 'index.php') +
					'?title=' + encodeURIComponent(e.title) +
					'&diff=' + encodeURIComponent(e.revid) +
					'&oldid=' + encodeURIComponent(e.old_revid));
		}

		// TODO: Classify the nowiki-introduced diff according
		// to the type of nowiki it is.

		return titles;
	},
		out);

	// More to fetch?
	var resContinue = body.continue;
	if (resContinue) {
		fetchArgs.opts.continue = resContinue.continue;
		fetchArgs.opts.rccontinue = resContinue.rccontinue;
		yield fetchAll(fetchArgs, out);
	} else {
		var fileName = './' + fetchArgs.prefix + '.rc_nowiki.txt';
		console.warn('Got ' + out.length + ' titles from ' + fetchArgs.prefix + '; writing to ' + fileName);
		for (var k in stats) {
			console.warn(fetchArgs.prefix + " date: " + k + " had " + stats[k] + " nowikied edits");
		}
		yield fs.writeFile(fileName, out.join('\n') + '\n');
	}
});

fetchAll = Promise.async(function *(fetchArgs, out) {
	var requestOpts = {
		method: 'GET',
		followRedirect: true,
		uri: fetchArgs.apiURI,
		qs: fetchArgs.opts,
	};

	// console.log('Fetching ' + fetchArgs.opts.rclimit + ' results from ' + fetchArgs.prefix + "; URI: " + fetchArgs.apiURI + "; opts: " + JSON.stringify(fetchArgs.opts));
	var resp = yield ScriptUtils.retryingHTTPRequest(2, requestOpts);
	yield processRes(fetchArgs, out, resp[1]);
});

Promise.all(wikis.map(function(obj) {
	var prefix = obj.prefix;
	var domain = prefix.replace(/wiki/, '.wikipedia.org');
	var opts = {
		action: 'query',
		list: 'recentchanges',
		format: 'json',
		rcprop: 'title|tags|ids|timestamp',
		// Only from main space
		rcnamespace: '0',
		// Ignore bot edits
		rcshow: '!bot',
		// Order from older to newer for a specific day
		rcdir: 'newer',
		rcstart: '2018-01-01T00:00:00Z',
		rcend: '2018-01-03T23:59:59Z',
		// Get edits marked with a nowiki tag filter
		rctag: obj.nowiki,
		rclimit: 500,
		'continue': '',
	};

	// init stats
	obj.stats = {};

	console.log('Processing: ' + prefix);
	var fetchArgs = {
		wiki: obj,
		prefix: prefix,
		apiURI: 'http://' + domain + '/w/api.php',
		opts: opts,
	};
	return fetchAll(fetchArgs, []);
})).done();
