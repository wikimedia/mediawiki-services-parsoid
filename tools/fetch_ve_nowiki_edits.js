'use strict';

const processRCForWikis = require('./RCUtils.js').RCUtils.processRCForWikis;

const wikis = [
	{ prefix: 'enwiki', tags: 'nowiki added' },
	{ prefix: 'frwiki', tags: 'nowiki' },
	{ prefix: 'itwiki', tags: 'nowiki' },
	{ prefix: 'hewiki', tags: 'nowiki' },
	// We need to figure out what the nowiki tag filter
	// is for these wikis and update them here.
	// { prefix: 'ruwiki', tags: 'nowiki' },
	// { prefix: 'plwiki', tags: 'nowiki' },
	// { prefix: 'ptwiki', tags: 'nowiki' },
	// { prefix: 'eswiki', tags: 'nowiki' },
	// { prefix: 'nlwiki', tags: 'nowiki' },
	// { prefix: 'dewiki', tags: 'nowiki' },
];

// Dummy diff processing: nothing to do!
function processDiff() {
	return true;
}

processRCForWikis(
	wikis,
	{
		rcstart: '2023-05-15T00:00:00Z',
		rcend: '2023-05-15T11:59:59Z',
	},
	{
		fileSuffix: '_nowiki',
		processDiff: processDiff,
	}
);

