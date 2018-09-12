#!/usr/bin/env node

/**
 * Simple script to update sitematrix.json
 */

'use strict';

require('../core-upgrade.js');

var Promise = require('../lib/utils/promise.js');
var Util = require('../lib/utils/Util.js').Util;

var fs = require('pn/fs');
var path = require('path');

var downloadUrl = 'https://en.wikipedia.org/w/api.php?action=sitematrix&format=json';
var filename = path.join(__dirname, '/../lib/config/wmf.sitematrix.json');

Promise.async(function *() {
	var resp = yield Util.retryingHTTPRequest(1, {
		url: downloadUrl,
		json: true,
	});
	var res = resp[0];
	var body = resp[1];
	if (res.statusCode !== 200) {
		throw 'Error fetching sitematrix! Returned ' + res.statusCode;
	}
	yield fs.writeFile(filename, JSON.stringify(body, null, '\t'));
	console.log('Wrote', filename);
	console.log('Success!');
})().done();
