'use strict';

require('../core-upgrade.js');
const fs = require('pn/fs');
const Promise = require('../lib/utils/promise.js');
const ScriptUtils = require('./ScriptUtils.js').ScriptUtils;

async function processRes(args, out, body) {
	// Accum titles
	body = JSON.parse(body);
	const stats = args.wiki.stats;
	const tags = args.wiki.tags || [];
	const haveTags = tags.length > 0;

	const results = body.query ? body.query.recentchanges : [];
	for (const i in results) {
		const e = results[i];
		// Intersect tags with e.tags to see if this a matching edit
		if (!haveTags || e.tags.some(v => tags.includes(v))) {
			const date = e.timestamp.replace(/T.*$/, '');
			if (!stats[date]) {
				stats[date] = 0;
			}
			stats[date] += 1;
			const diffUrl = args.apiURI.replace(/api.php/, 'index.php') +
					'?title=' + encodeURIComponent(e.title) +
					'&diff=' + encodeURIComponent(e.revid) +
					'&oldid=' + encodeURIComponent(e.old_revid);

			const matchingDiff = await args.rcOpts.processDiff(args, diffUrl);
			if (matchingDiff) {
				out.push("DATE: " + e.timestamp + "; DIFF: " + diffUrl);
			}
		}

		// TODO: Classify the nowiki-introduced diff according
		// to the type of nowiki it is.
	}

	// More to fetch?
	const resContinue = body.continue;
	if (resContinue) {
		args.apiOpts.continue = resContinue.continue;
		args.apiOpts.rccontinue = resContinue.rccontinue;
		await fetchAll(args, out);
	} else {
		const fileName = './' + args.prefix + args.rcOpts.fileSuffix + '.txt';
		console.warn('Got ' + out.length + ' titles from ' + args.prefix + '; writing to ' + fileName);
		for (const k in stats) {
			console.warn(args.prefix + " date: " + k + " had " + stats[k] + " edits");
		}
		await fs.writeFile(fileName, out.join('\n') + '\n');
	}
}

async function fetchAll (args, out) {
	try {
		const requestOpts = {
			method: 'GET',
			followRedirect: true,
			uri: args.apiURI,
			qs: args.apiOpts,
		};

		console.log("\nFetching " + args.apiOpts.rclimit + ' results from ' + args.prefix + "; URI: " + args.apiURI + "; apiOpts: " + JSON.stringify(args.apiOpts));
		const resp = await ScriptUtils.retryingHTTPRequest(2, requestOpts);
		await processRes(args, out, resp[1]);
	} catch (e) {
		// Catch exceptions to ensure they don't cause this promise to get rejected
		// and cause upstream failure of Promise.all()
	}
}

async function processWiki(wiki, apiOpts, rcOpts) {
	if (rcOpts.fetchMWs) {
		await rcOpts.fetchMWs(wiki);
	}
	const prefix = wiki.prefix;
	const wikiUrl = wiki.url || (
		// FIXME: Defaults to assumption of the wiki being a wikipedia
		'http://' + prefix.replace(/_/g, '-').replace(/wiki/, '.wikipedia.org')
	);
	const qsOpts = {
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
		// Get edits marked with 'visualeditor' tag filter
		rctag: 'visualeditor',
		rclimit: 500,
		'continue': '',
	};

	// Override rc-fetch defaults
	Object.assign(qsOpts, apiOpts);

	// *nit stats
	wiki.stats = {};

	console.log('Processing: ' + prefix);
	return fetchAll(
		{
			wiki: wiki,
			prefix: prefix,
			apiURI: wikiUrl + '/w/api.php',
			apiOpts: qsOpts,
			rcOpts: rcOpts
		},
		[]
	);
}

const batchSize = 7; // 7 wikis at a time

async function processRCForWikis(wikis, apiOpts, rcOpts) {
	let next = wikis;
	while (next.length > 0) {
		const slice = next.slice(0, batchSize);
		next = next.slice(batchSize);

		console.log(
			"------ Processing slice: " +
			JSON.stringify(slice.map(w => w.prefix)) +
			" ------"
		);
		console.log('---- next has: ' + next.length + ' wikis ----');

		// Use await to force completion of this batch before next slice
		await Promise.all(slice.map(function(wiki) {
			return processWiki(wiki, apiOpts, rcOpts);
		}));
	}

}

if (typeof module === "object") {
	module.exports.RCUtils = {
		processRCForWikis: processRCForWikis
	};
}
