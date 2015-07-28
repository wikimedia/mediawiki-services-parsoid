#!/usr/bin/env node
'use strict';
require('../../lib/core-upgrade.js');

/**
 * A client for testing round-tripping of articles.
 */

var http = require('http');
var request = require('request');
var cluster = require('cluster');
var qs = require('querystring');
var exec = require('child_process').exec;
var apiServer = require('../apiServer.js');
var Util = require('../../lib/mediawiki.Util.js').Util;
var JSUtils = require('../../lib/jsutils.js').JSUtils;

var commit;
var ctime;
var lastCommit;
var lastCommitTime;
var lastCommitCheck;
var repoPath = __dirname;

var config = require(process.argv[2] || './config.js');
var parsoidURL = config.parsoidURL;
var rtTest = require('../roundtrip-test.js');

var getTitle = function(cb) {
	var requestOptions = {
		uri: 'http://' + config.server.host + ':' +
			config.server.port + '/title?commit=' + commit + '&ctime=' + encodeURIComponent(ctime),
		method: 'GET',
	};
	var retries = 10;

	var callback = function(error, response, body) {
		if (error || !response) {
			setTimeout(function() { cb('start'); }, 15000);
			return;
		}

		var resp;
		switch (response.statusCode) {
			case 200:
				resp = JSON.parse(body);
				cb('runTest', resp);
				break;
			case 404:
				console.log('The server doesn\'t have any work for us right now, waiting half a minute....');
				setTimeout(function() { cb('start'); }, 30000);
				break;
			case 426:
				console.log("Update required, exiting.");
				// Signal our voluntary suicide to the parent if running as a
				// cluster worker, so that it does not restart this client.
				// Without this, the code is never actually updated as a newly
				// forked client will still run the old code.
				if (cluster.worker) {
					cluster.worker.kill();
				} else {
					process.exit(0);
				}
				break;
			default:
				console.log('There was some error (' + response.statusCode + '), but that is fine. Waiting 15 seconds to resume....');
				setTimeout(function() { cb('start'); }, 15000);
		}
	};

	Util.retryingHTTPRequest(10, requestOptions, callback);
};

var runTest = function(cb, test) {
	rtTest.runTests(test.title, {
		setup: config.setup,
		prefix: test.prefix,
		rtTestMode: true,
		parsoidURL: parsoidURL,
	}, rtTest.xmlFormat).nodify(function(err, results) {
		var callback = null;
		if (err) {
			// Log it to console (for gabriel to watch scroll by)
			console.error('Error in %s:%s: %s\n%s', test.prefix, test.title,
				err, err.stack || '');
			/*
			 * If you're looking at the line below and thinking "Why in the
			 * hell would they have done that, it causes unnecessary problems
			 * with the clients crashing", you're absolutely right. This is
			 * here because we use a supervisor instance to run our test
			 * clients, and we rely on it to restart dead'ns.
			 *
			 * In sum, easier to die than to worry about having to reset any
			 * broken application state.
			 */
			callback = function() { process.exit(1); };
		}
		cb('postResult', err, results, test, callback);
	});
};

/**
 * Get the current git commit hash.
 * The `cb` parameter is optional; return a promise for the result
 * as an array: [lastCommit, lastCommitTime].
 */
var getGitCommit = function(cb) {
	var now = Date.now();
	cb = JSUtils.mkPromised(cb, true);

	if (!lastCommitCheck || (now - lastCommitCheck) > (5 * 60 * 1000)) {
		lastCommitCheck = now;
		exec('git log --max-count=1 --pretty=format:"%H %ci"', { cwd: repoPath }, function(err, data) {
			if (err) { return cb(err); }
			var cobj = data.match(/^([^ ]+) (.*)$/);
			if (!cobj) {
				return cb("Error, couldn't find the current commit", null, null);
			} else {
				lastCommit = cobj[1];
				// convert the timestamp to UTC
				lastCommitTime = new Date(cobj[2]).toISOString();
				// console.log( 'New commit: ', cobj[1], lastCommitTime );
				cb(null, cobj[1], lastCommitTime);
			}
		});
	} else {
		cb(null, lastCommit, lastCommitTime);
	}
	return cb.promise;
};

var postResult = function(err, result, test, finalCB, cb) {
	getGitCommit(function(err2, newCommit, newTime) {
		if (err2 || !newCommit) {
			console.log("Exiting, couldn't find the current commit");
			process.exit(1);
		}

		if (err) {
			result =
				'<error type="' + err.name + '">' +
				err.toString() +
				'</error>';
		}

		result = qs.stringify({ results: result, commit: newCommit, ctime: newTime, test: JSON.stringify(test) });

		var requestOptions = {
			host: config.server.host,
			port: config.server.port,
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			path: '/result/' + encodeURIComponent(test.title) + '/' + test.prefix,
			method: 'POST',
		};

		var req = http.request(requestOptions, function(res) {
			res.on('end', function() {
				if (finalCB) {
					finalCB();
				} else {
					cb('start');
				}
			});
			res.resume();
		});

		req.write(result, 'utf8');
		req.end();
	});
};

var callbackOmnibus = function(which) {
	var args = Array.prototype.slice.call(arguments);
	var test;
	switch (args.shift()) {
		case 'runTest':
			test = args[0];
			console.log('Running a test on', test.prefix + ':' + test.title, '....');
			args.unshift(callbackOmnibus);
			runTest.apply(null, args);
			break;

		case 'postResult':
			test = args[2];
			console.log('Posting a result for', test.prefix + ':' + test.title, '....');
			args.push(callbackOmnibus);
			postResult.apply(null, args);
			break;

		case 'start':
			getGitCommit(function(err, latestCommit) {
				if (err) {
					console.log("Couldn't find latest commit.", err);
					process.exit(1);
				}
				if (latestCommit !== commit) {
					console.log('Exiting because the commit hash changed');
					process.exit(0);
				}

				getTitle(callbackOmnibus);
			});
			break;

		default:
			console.assert(false, 'Bad callback argument: ' + which);
	}
};

if (typeof module === 'object') {
	module.exports.getTitle = getTitle;
	module.exports.runTest = runTest;
	module.exports.postResult = postResult;
}

if (module && !module.parent) {
	var getGitCommitCb = function(commitHash, commitTime) {
		commit = commitHash;
		ctime = commitTime;
		callbackOmnibus('start');
	};

	// Enable heap dumps in /tmp on kill -USR2.
	// See https://github.com/bnoordhuis/node-heapdump/
	// For node 0.6/0.8: npm install heapdump@0.1.0
	// For 0.10: npm install heapdump
	process.on('SIGUSR2', function() {
		var heapdump = require('heapdump');
		console.error('SIGUSR2 received! Writing snapshot.');
		process.chdir('/tmp');
		heapdump.writeSnapshot();
	});

	if (!config.parsoidURL) {
		// If no Parsoid server was passed, start our own
		apiServer.startParsoidServer({ quiet: true }).then(function(ret) {
			parsoidURL = ret.url;
			return getGitCommit().spread(getGitCommitCb);
		}).done();
		apiServer.exitOnProcessTerm();
	} else {
		getGitCommit().spread(getGitCommitCb).done();
	}
}
