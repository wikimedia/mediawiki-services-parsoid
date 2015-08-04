#!/usr/bin/env node

'use strict';
require('../lib/core-upgrade.js');
var fs = require('fs');
var request = require('request');

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

var processRes, fetchAll;

processRes = function(fetchArgs, out, err, resp, body) {
	if (err || resp.statusCode !== 200) {
		if (err) {
			console.error('Error: ' + err);
		}
		if (resp) {
			console.error('Status code: ' + resp.statusCode);
		}
		return;
	}

	// Accum titles
	body = JSON.parse(body);
	var stats = fetchArgs.wiki.stats;
	Array.prototype.reduce.call(body.query ? body.query.recentchanges : [],
		function(titles, e) {
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
	var resContinue = body['continue'];
	if (resContinue) {
		fetchArgs.opts['continue'] = resContinue['continue'];
		fetchArgs.opts.rccontinue = resContinue.rccontinue;
		fetchAll(fetchArgs, out);
	} else {
		var fileName = './' + fetchArgs.prefix + '.rc_nowiki.txt';
		console.warn('Got ' + out.length + ' titles from ' + fetchArgs.prefix + '; writing to ' + fileName);
		for (var k in stats) {
			console.warn(fetchArgs.prefix + " date: " + k + " had " + stats[k] + " nowikied edits");
		}
		fs.writeFileSync(fileName, out.join('\n') + '\n');
	}
};

fetchAll = function(fetchArgs, out) {
	var requestOpts = {
		method: 'GET',
		followRedirect: true,
		uri: fetchArgs.apiURI,
		qs: fetchArgs.opts,
	};

	// console.log('Fetching ' + fetchArgs.opts.rclimit + ' results from ' + fetchArgs.prefix + "; URI: " + fetchArgs.apiURI + "; opts: " + JSON.stringify(fetchArgs.opts));
	request(requestOpts, processRes.bind(null, fetchArgs, out));
};

wikis.forEach(function(obj) {
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
		rcstart: '2015-08-12T00:00:00Z',
		rcend: '2015-08-13T23:59:59Z',
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
	fetchAll(fetchArgs, []);
});
