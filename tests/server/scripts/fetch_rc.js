'use strict';
require('../../lib/core-upgrade.js');
var fs = require('fs');
var request = require('request');

var wikis = [
	{ prefix: 'enwiki', limit: 30 },
	{ prefix: 'dewiki', limit: 10 },
	{ prefix: 'nlwiki', limit: 10 },
	{ prefix: 'frwiki', limit: 10 },
	{ prefix: 'itwiki', limit: 10 },
	{ prefix: 'ruwiki', limit: 10 },
	{ prefix: 'eswiki', limit: 10 },
	{ prefix: 'svwiki', limit: 8 },
	{ prefix: 'plwiki', limit: 8 },
	{ prefix: 'jawiki', limit: 8 },
	{ prefix: 'arwiki', limit: 7 },
	{ prefix: 'hewiki', limit: 7 },
	{ prefix: 'hiwiki', limit: 7 },
	{ prefix: 'kowiki', limit: 7 },
	{ prefix: 'zhwiki', limit: 5 },
	{ prefix: 'ckbwiki', limit: 1 },
	{ prefix: 'cuwiki', limit: 1 },
	{ prefix: 'cvwiki', limit: 1 },
	{ prefix: 'hywiki', limit: 1 },
	{ prefix: 'iswiki', limit: 1 },
	{ prefix: 'kaawiki', limit: 1 },
	{ prefix: 'kawiki', limit: 1 },
	{ prefix: 'lbewiki', limit: 1 },
	{ prefix: 'lnwiki', limit: 1 },
	{ prefix: 'mznwiki', limit: 1 },
	{ prefix: 'pnbwiki', limit: 1 },
	{ prefix: 'ukwiki', limit: 1 },
	{ prefix: 'uzwiki', limit: 1 },
	{ prefix: 'enwiktionary', limit: 1 },
	{ prefix: 'frwiktionary', limit: 1 },
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
	Array.prototype.reduce.call(body.query.recentchanges,
		function(titles, e) {
			titles.push(e.title);
			return titles;
		},
		out);

	// More to fetch?
	var resContinue = body['continue'];
	if (resContinue && fetchArgs.count > 0) {
		fetchArgs.opts['continue'] = resContinue['continue'];
		fetchArgs.opts.rccontinue = resContinue.rccontinue;
		fetchAll(fetchArgs, out);
	} else {
		var fileName = './' + fetchArgs.prefix + '.rc_titles.txt';
		console.warn('Got ' + out.length + ' titles from ' + fetchArgs.prefix + '; writing to ' + fileName);
		fs.writeFileSync(fileName, out.join('\n'));
	}
};

fetchAll = function(fetchArgs, out) {
	var n = fetchArgs.count;
	var opts = fetchArgs.opts;
	opts.rclimit = n < 500 ? n : 500;
	var requestOpts = {
		method: 'GET',
		followRedirect: true,
		uri: fetchArgs.uri,
		qs: opts,
	};
	fetchArgs.count -= opts.rclimit;

	// console.log('Fetching ' + opts.rclimit + ' results from ' + fetchArgs.prefix);
	request(requestOpts, processRes.bind(null, fetchArgs, out));
};

var FRACTION = 0.31;
wikis.forEach(function(obj) {
	var prefix = obj.prefix;
	var count = obj.limit * 1000 * FRACTION;
	var domain = prefix.replace(/wiki/, '.wikipedia.org').replace(/wiktionary/, '.wiktionary.org');
	var opts = {
		action: 'query',
		list: 'recentchanges',
		format: 'json',
		rcnamespace: '0',
		rcprop: 'title',
		rcshow: '!bot',
		rctoponly: true,
		'continue': '',
	};

	console.log('Processing: ' + prefix);
	var fetchArgs = {
		prefix: prefix,
		count: count,
		uri: 'http://' + domain + '/w/api.php',
		opts: opts,
	};
	fetchAll(fetchArgs, []);
});

