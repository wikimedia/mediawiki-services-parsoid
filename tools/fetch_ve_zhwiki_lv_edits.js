'use strict';

const Promise = require('../lib/utils/promise.js');
const ScriptUtils = require('./ScriptUtils.js').ScriptUtils;
const processRCForWikis = require('./RCUtils.js').RCUtils.processRCForWikis;

const wikis = [
	{ prefix: 'zhwiki', tags: 'visualeditor' },
];

const processDiff = Promise.async(function *(fetchArgs, diffUrl) {
	// Fetch the diff
	const requestOpts = {
		method: 'GET',
		followRedirect: true,
		uri: diffUrl,
		timeout: 10000, // 10 sec
	};
	const resp = yield ScriptUtils.retryingHTTPRequest(3, requestOpts);

	const re = new RegExp("/-{zh-/", 'g');
	const matches = resp[1].match(re);
	const ret = matches && matches.length % 2 === 1;
	if (ret) {
		console.log("\nlv bug seen in " + diffUrl);
		return true;
	} else {
		process.stderr.write(".");
		return false;
	}
});

processRCForWikis(
	wikis,
	{
		rcstart: '2026-02-14T00:00:00Z',
		rcend: '2026-02-28T11:59:59Z',
		rctag: 'visualeditor', // visualeditor
	},
	{
		fileSuffix: '_zh_lv',
		processDiff: processDiff,
	}
);
