#!/usr/bin/env node
"use strict";
require('../../lib/core-upgrade.js');

var express = require('express');
var yargs = require('yargs');
var hbs = require('handlebars');
var Diff = require('./diff.js').Diff;
var RH = require('./render.helpers.js').RenderHelpers;

// Default options
var defaults = {
	'host':           'localhost',
	'port':           3306,
	'database':       'parsoid',
	'user':           'parsoid',
	'password':       'parsoidpw',
	'debug':          false,
	'fetches':        6,
	'tries':          6,
	'cutofftime':     600,
	'batch':          50,
	generateTitleUrl: function(server, prefix, title) {
		return server.replace(/\/$/, '') + "/_rt/" + prefix + "/" + title;
	},
};

// Command line options
var opts = yargs.usage('Usage: $0 [connection parameters]')
	.options('help', {
		'boolean': true,
		'default': false,
		describe: "Show usage information.",
	})
	.options('config', {
		describe: 'Configuration file for the server',
		'default': './server.settings.js',
	})
	.options('h', {
		alias: 'host',
		describe: 'Hostname of the database server.',
	})
	.options('P', {
		alias: 'port',
		describe: 'Port number to use for connection.',
	})
	.options('D', {
		alias: 'database',
		describe: 'Database to use.',
	})
	.options('u', {
		alias: 'user',
		describe: 'User for MySQL login.',
	})
	.options('p', {
		alias: 'password',
		describe: 'Password.',
	})
	.options('d', {
		alias: 'debug',
		'boolean': true,
		describe: "Output MySQL debug data.",
	})
	.options('f', {
		alias: 'fetches',
		describe: "Number of times to try fetching a page.",
	})
	.options('t', {
		alias: 'tries',
		describe: "Number of times an article will be sent for testing " +
			"before it's considered an error.",
	})
	.options('c', {
		alias: 'cutofftime',
		describe: "Time in seconds to wait for a test result.",
	})
	.options('b', {
		alias: 'batch',
		describe: "Number of titles to fetch from database in one batch.",
	});
var argv = opts.argv;

if (argv.help) {
	opts.showHelp();
	process.exit(0);
}

// Settings file
var settings;
try {
	settings = require(argv.config);
} catch (e) {
	console.error("Aborting! Exception reading " + argv.config + ": " + e);
	return;
}

// SSS FIXME: Awkward, but does the job for now.
// Helpers need settings
RH.settings = settings;

var perfConfig = settings.perfConfig;
var parsoidRTConfig = settings.parsoidRTConfig;

var getOption = function(opt) {
	var value;

	// Check possible options in this order: command line, settings file, defaults.
	if (argv.hasOwnProperty(opt)) {
		value = argv[ opt ];
	} else if (settings.hasOwnProperty(opt)) {
		value = settings[ opt ];
	} else if (defaults.hasOwnProperty(opt)) {
		value = defaults[ opt ];
	} else {
		return undefined;
	}

	// Check the boolean options, 'false' and 'no' should be treated as false.
	// Copied from mediawiki.Util.js.
	if (opt === 'debug') {
		if ((typeof value) === 'string' && /^(no|false)$/i.test(value)) {
			return false;
		}
	}
	return value;
};

// The maximum number of tries per article
var maxTries = getOption('tries');
// The maximum number of fetch retries per article
var maxFetchRetries = getOption('fetches');
// The time to wait before considering a test has failed
var cutOffTime = getOption('cutofftime');
// The number of pages to fetch at once
var batchSize = getOption('batch');
var debug = getOption('debug');

var mysql = require('mysql');
var db = mysql.createConnection({
	host:               getOption('host'),
	port:               getOption('port'),
	database:           getOption('database'),
	user:               getOption('user'),
	password:           getOption('password'),
	multipleStatements: true,
	charset:            'UTF8_BIN',
	debug:              debug,
});

var queues = require('mysql-queues');
queues(db, debug);

// Try connecting to the database.
process.on('exit', function() {
	db.end();
});
db.connect(function(err) {
	if (err) {
		console.error("Unable to connect to database, error: " + err.toString());
		process.exit(1);
	}
});

// ----------------- The queries --------------
var dbGetTitle =
	'SELECT id, title, prefix, claim_hash, claim_num_tries ' +
	'FROM pages ' +
	'WHERE num_fetch_errors < ? AND ' +
	'( claim_hash != ? OR ' +
		'( claim_num_tries < ? AND claim_timestamp < ? ) ) ' +
	'ORDER BY claim_num_tries DESC, latest_score DESC, ' +
	'claim_timestamp ASC LIMIT ? ' +
	// Stop other transactions from reading until we finish this one.
	'FOR UPDATE';

var dbIncrementFetchErrorCount =
	'UPDATE pages SET ' +
		'claim_hash = ?, ' +
		'num_fetch_errors = num_fetch_errors + 1, ' +
		'claim_num_tries = 0 ' +
		'WHERE title = ? AND prefix = ?';

var dbInsertCommit =
	'INSERT IGNORE INTO commits ( hash, timestamp ) ' +
	'VALUES ( ?, ? )';

var dbFindPage =
	'SELECT id ' +
	'FROM pages ' +
	'WHERE title = ? AND prefix = ?';

var dbUpdatePageClaims =
	'UPDATE pages SET claim_hash = ?, claim_timestamp = ?, claim_num_tries = claim_num_tries + 1 ' +
	'WHERE id IN ( ? )';

var dbInsertResult =
	'INSERT INTO results ( page_id, commit_hash, result ) ' +
	'VALUES ( ?, ?, ? ) ' +
	'ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID( id ), ' +
		'result = VALUES( result )';

var dbInsertStats =
	'INSERT INTO stats ' +
	'( skips, fails, errors, selser_errors, score, page_id, commit_hash ) ' +
	'VALUES ( ?, ?, ?, ?, ?, ?, ? ) ' +
	'ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID( id ), ' +
		'skips = VALUES( skips ), fails = VALUES( fails ), ' +
		'errors = VALUES( errors ), selser_errors = VALUES(selser_errors), ' +
		'score = VALUES( score )';

var dbUpdatePageLatestResults =
	'UPDATE pages ' +
	'SET latest_stat = ?, latest_score = ?, latest_result = ?, ' +
	'claim_hash = ?, claim_timestamp = NULL, claim_num_tries = 0 ' +
    'WHERE id = ?';

var dbUpdateCrashersClearTries =
	'UPDATE pages ' +
	'SET claim_num_tries = 0 ' +
	'WHERE claim_hash != ? AND claim_num_tries >= ?';

var dbStatsQuery =
	'SELECT ' +
	'(select hash from commits order by timestamp desc limit 1) as maxhash, ' +
	'(select hash from commits order by timestamp desc limit 1 offset 1) as secondhash, ' +
	'(select count(*) from stats where stats.commit_hash = ' +
		'(select hash from commits order by timestamp desc limit 1)) as maxresults, ' +
	'(select avg(stats.errors) from stats join pages on ' +
		'pages.latest_stat = stats.id) as avgerrors, ' +
	'(select avg(stats.fails) from stats join pages on ' +
		'pages.latest_stat = stats.id) as avgfails, ' +
	'(select avg(stats.skips) from stats join pages on ' +
		'pages.latest_stat = stats.id) as avgskips, ' +
	'(select avg(stats.score) from stats join pages on ' +
		'pages.latest_stat = stats.id) as avgscore, ' +
	'count(*) AS total, ' +
	'count(CASE WHEN stats.errors=0 THEN 1 ELSE NULL END) AS no_errors, ' +
	'count(CASE WHEN stats.errors=0 AND stats.fails=0 ' +
		'then 1 else null end) AS no_fails, ' +
	'count(CASE WHEN stats.errors=0 AND stats.fails=0 AND stats.skips=0 ' +
		'then 1 else null end) AS no_skips, ' +
	// get regression count between last two commits
	'(SELECT count(*) ' +
	'FROM pages p ' +
	'JOIN stats AS s1 ON s1.page_id = p.id ' +
	'JOIN stats AS s2 ON s2.page_id = p.id ' +
	'WHERE s1.commit_hash = (SELECT hash ' +
		'FROM commits ORDER BY timestamp DESC LIMIT 1 ) ' +
	'AND s2.commit_hash = (SELECT hash ' +
		'FROM commits ORDER BY timestamp DESC LIMIT 1 OFFSET 1) ' +
	'AND s1.score > s2.score ) as numregressions, ' +
	// get fix count between last two commits
	'(SELECT count(*) ' +
		'FROM pages ' +
		'JOIN stats AS s1 ON s1.page_id = pages.id ' +
		'JOIN stats AS s2 ON s2.page_id = pages.id ' +
		'WHERE s1.commit_hash = (SELECT hash FROM commits ORDER BY timestamp DESC LIMIT 1 ) ' +
	'AND s2.commit_hash = (SELECT hash FROM commits ORDER BY timestamp DESC LIMIT 1 OFFSET 1 ) ' +
	'AND s1.score < s2.score ) as numfixes, '  +
	// Get latest commit crashers
	'(SELECT count(*) ' +
		'FROM pages ' +
		'WHERE claim_hash = (SELECT hash FROM commits ORDER BY timestamp DESC LIMIT 1) ' +
			'AND claim_num_tries >= ? ' +
			'AND claim_timestamp < ?) AS crashers, ' +
	// Get num of rt selser errors
	'(SELECT count(*) ' +
		'FROM pages ' +
		'JOIN stats ON pages.id = stats.page_id ' +
		'WHERE stats.commit_hash = (SELECT hash FROM commits ORDER BY timestamp DESC LIMIT 1) ' +
			'AND stats.selser_errors > 0) AS rtselsererrors ' +

	'FROM pages JOIN stats on pages.latest_stat = stats.id';

var dbPerWikiStatsQuery =
	'SELECT ' +
	'(select hash from commits order by timestamp desc limit 1) as maxhash, ' +
	'(select hash from commits order by timestamp desc limit 1 offset 1) as secondhash, ' +
	'(select count(*) from stats join pages on stats.page_id = pages.id ' +
		'where stats.commit_hash = ' +
		'(select hash from commits order by timestamp desc limit 1) ' +
		'and pages.prefix = ?) as maxresults, ' +
	'(select avg(stats.errors) from stats join pages on ' +
		'pages.latest_stat = stats.id where pages.prefix = ?) as avgerrors, ' +
	'(select avg(stats.fails) from stats join pages on ' +
		'pages.latest_stat = stats.id where pages.prefix = ?) as avgfails, ' +
	'(select avg(stats.skips) from stats join pages on ' +
		'pages.latest_stat = stats.id where pages.prefix = ?) as avgskips, ' +
	'(select avg(stats.score) from stats join pages on ' +
		'pages.latest_stat = stats.id where pages.prefix = ?) as avgscore, ' +
	'count(*) AS total, ' +
	'count(CASE WHEN stats.errors=0 THEN 1 ELSE NULL END) AS no_errors, ' +
	'count(CASE WHEN stats.errors=0 AND stats.fails=0 ' +
		'then 1 else null end) AS no_fails, ' +
	'count(CASE WHEN stats.errors=0 AND stats.fails=0 AND stats.skips=0 ' +
		'then 1 else null end) AS no_skips, ' +
	// get regression count between last two commits
	'(SELECT count(*) ' +
	'FROM pages p ' +
	'JOIN stats AS s1 ON s1.page_id = p.id ' +
	'JOIN stats AS s2 ON s2.page_id = p.id ' +
	'WHERE s1.commit_hash = (SELECT hash ' +
		'FROM commits ORDER BY timestamp DESC LIMIT 1 ) ' +
		'AND s2.commit_hash = (SELECT hash ' +
		'FROM commits ORDER BY timestamp DESC LIMIT 1 OFFSET 1) ' +
		'AND p.prefix = ? ' +
		'AND s1.score > s2.score ) as numregressions, ' +
	// get fix count between last two commits
	'(SELECT count(*) ' +
		'FROM pages ' +
		'JOIN stats AS s1 ON s1.page_id = pages.id ' +
		'JOIN stats AS s2 ON s2.page_id = pages.id ' +
		'WHERE s1.commit_hash = (SELECT hash FROM commits ORDER BY timestamp DESC LIMIT 1 ) ' +
		'AND s2.commit_hash = (SELECT hash FROM commits ORDER BY timestamp DESC LIMIT 1 OFFSET 1 ) ' +
		'AND pages.prefix = ? ' +
		'AND s1.score < s2.score ) as numfixes, ' +
	// Get latest commit crashers
	'(SELECT count(*) ' +
		'FROM pages WHERE prefix = ? ' +
			'AND claim_hash = (SELECT hash FROM commits ORDER BY timestamp DESC LIMIT 1) ' +
			'AND claim_num_tries >= ? ' +
			'AND claim_timestamp < ?) AS crashers, ' +
	// Get num of rt selser errors
	'(SELECT count(*) ' +
		'FROM pages ' +
		'JOIN stats ON pages.id = stats.page_id ' +
		'WHERE pages.prefix = ? ' +
			'AND stats.commit_hash = (SELECT hash FROM commits ORDER BY timestamp DESC LIMIT 1 ) ' +
			'AND stats.selser_errors > 0) AS rtselsererrors ' +

	'FROM pages JOIN stats on pages.latest_stat = stats.id WHERE pages.prefix = ?';

var dbFailsQuery =
	'SELECT pages.title, pages.prefix, commits.hash, stats.errors, stats.fails, stats.skips ' +
	'FROM stats ' +
	'JOIN (' +
	'	SELECT MAX(id) AS most_recent FROM stats GROUP BY page_id' +
	') AS s1 ON s1.most_recent = stats.id ' +
	'JOIN pages ON stats.page_id = pages.id ' +
	'JOIN commits ON stats.commit_hash = commits.hash ' +
	'ORDER BY stats.score DESC ' +
	'LIMIT 40 OFFSET ?' ;

var dbGetOneResult =
	'SELECT result FROM results ' +
	'JOIN commits ON results.commit_hash = commits.hash ' +
	'JOIN pages ON pages.id = results.page_id ' +
	'WHERE pages.title = ? AND pages.prefix = ? ' +
	'ORDER BY commits.timestamp DESC LIMIT 1' ;

var dbGetResultWithCommit =
    'SELECT result FROM results ' +
    'JOIN pages ON pages.id = results.page_id ' +
    'WHERE results.commit_hash = ? AND pages.title = ? AND pages.prefix = ?';

var dbFailedFetches =
	'SELECT title, prefix FROM pages WHERE num_fetch_errors >= ?';

var dbCrashers =
	'SELECT pages.title, pages.prefix, pages.claim_hash, commits.timestamp ' +
		'FROM pages JOIN commits ON (pages.claim_hash = commits.hash) ' +
		'WHERE claim_num_tries >= ? ' +
		'AND claim_timestamp < ? ' +
		'ORDER BY commits.timestamp DESC';

var dbFailsDistribution =
	'SELECT fails, count(*) AS num_pages ' +
	'FROM stats ' +
	'JOIN pages ON pages.latest_stat = stats.id ' +
	'GROUP by fails';

var dbSkipsDistribution =
	'SELECT skips, count(*) AS num_pages ' +
	'FROM stats ' +
	'JOIN pages ON pages.latest_stat = stats.id ' +
	'GROUP by skips';

// Limit to 100 recent commits
var dbCommits =
	'SELECT hash, timestamp ' +
	/*
	// get the number of fixes column
		'(SELECT count(*) ' +
		'FROM pages ' +
			'JOIN stats AS s1 ON s1.page_id = pages.id ' +
			'JOIN stats AS s2 ON s2.page_id = pages.id ' +
		'WHERE s1.commit_hash = (SELECT hash FROM commits c2 where c2.timestamp < c1.timestamp ORDER BY timestamp DESC LIMIT 1 ) ' +
			'AND s2.commit_hash = c1.hash AND s1.score < s2.score) as numfixes, ' +
	// get the number of regressions column
		'(SELECT count(*) ' +
		'FROM pages ' +
			'JOIN stats AS s1 ON s1.page_id = pages.id ' +
			'JOIN stats AS s2 ON s2.page_id = pages.id ' +
		'WHERE s1.commit_hash = (SELECT hash FROM commits c2 where c2.timestamp < c1.timestamp ORDER BY timestamp DESC LIMIT 1 ) ' +
			'AND s2.commit_hash = c1.hash AND s1.score > s2.score) as numregressions, ' +

	// get the number of tests for this commit column
		'(select count(*) from stats where stats.commit_hash = c1.hash) as numtests ' +
	*/
	'FROM commits c1 ' +
	'ORDER BY timestamp DESC LIMIT 100';

var dbCommitHashes =
	'SELECT hash FROM commits ORDER BY timestamp DESC';

var dbFixesBetweenRevs =
	'SELECT pages.title, pages.prefix, ' +
	's1.commit_hash AS new_commit, s1.errors AS errors, s1.fails AS fails, s1.skips AS skips, ' +
	's2.commit_hash AS old_commit, s2.errors AS old_errors, s2.fails AS old_fails, s2.skips AS old_skips ' +
	'FROM pages ' +
	'JOIN stats AS s1 ON s1.page_id = pages.id ' +
	'JOIN stats AS s2 ON s2.page_id = pages.id ' +
	'WHERE s1.commit_hash = ? AND s2.commit_hash = ? AND s1.score < s2.score ' +
	'ORDER BY s1.score - s2.score ASC ' +
	'LIMIT 40 OFFSET ?';

var dbNumFixesBetweenRevs =
	'SELECT count(*) as numFixes ' +
	'FROM pages ' +
	'JOIN stats AS s1 ON s1.page_id = pages.id ' +
	'JOIN stats AS s2 ON s2.page_id = pages.id ' +
	'WHERE s1.commit_hash = ? AND s2.commit_hash = ? AND s1.score < s2.score ';

var dbRegressionsBetweenRevs =
	'SELECT pages.title, pages.prefix, ' +
	's1.commit_hash AS new_commit, s1.errors AS errors, s1.fails AS fails, s1.skips AS skips, ' +
	's2.commit_hash AS old_commit, s2.errors AS old_errors, s2.fails AS old_fails, s2.skips AS old_skips ' +
	'FROM pages ' +
	'JOIN stats AS s1 ON s1.page_id = pages.id ' +
	'JOIN stats AS s2 ON s2.page_id = pages.id ' +
	'WHERE s1.commit_hash = ? AND s2.commit_hash = ? AND s1.score > s2.score ' +
	'ORDER BY s1.score - s2.score DESC ' +
	'LIMIT 40 OFFSET ?';

var dbNumRegressionsBetweenRevs =
	'SELECT count(*) as numRegressions ' +
	'FROM pages ' +
	'JOIN stats AS s1 ON s1.page_id = pages.id ' +
	'JOIN stats AS s2 ON s2.page_id = pages.id ' +
	'WHERE s1.commit_hash = ? AND s2.commit_hash = ? AND s1.score > s2.score ';

var dbResultsQuery =
	'SELECT result FROM results';

var dbResultsPerWikiQuery =
	'SELECT result FROM results ' +
	'JOIN pages ON pages.id = results.page_id ' +
	'WHERE pages.prefix = ?';

var dbGetTwoResults =
	'SELECT result FROM results ' +
	'JOIN commits ON results.commit_hash = commits.hash ' +
	'JOIN pages ON pages.id = results.page_id ' +
	'WHERE pages.title = ? AND pages.prefix = ? ' +
	'AND (commits.hash = ? OR commits.hash = ?) ' +
	'ORDER BY commits.timestamp';

var transFetchCB = function(msg, trans, failCb, successCb, err, result) {
	if (err) {
		trans.rollback(function() {
			if (failCb) {
				failCb (msg? msg + err.toString() : err, result);
			}
		});
	} else if (successCb) {
		successCb(result);
	}
};

var fetchPages = function(commitHash, cutOffTimestamp, cb) {
	var trans = db.startTransaction();
	trans.query(dbGetTitle, [maxFetchRetries, commitHash, maxTries, cutOffTimestamp, batchSize], transFetchCB.bind(null, 'Error getting next titles', trans, cb, function(rows) {
		if (!rows || rows.length === 0) {
			trans.commit(cb.bind(null, null, rows));
		} else {
			// Process the rows: Weed out the crashers.
			var pages = [];
			var pageIds = [];
			for (var i = 0; i < rows.length; i++) {
				var row = rows[i];
				pageIds.push(row.id);
				pages.push({ id: row.id, prefix: row.prefix, title: row.title });
			}
			trans.query(dbUpdatePageClaims, [commitHash, new Date(), pageIds], transFetchCB.bind(null, 'Error updating claims', trans, cb, function() {
				trans.commit(cb.bind(null, null, pages));
			}));
		}
	})).execute();
};

var fetchedPages = [];
var lastFetchedCommit = null;
var lastFetchedDate = new Date(0);
var knownCommits;

var getTitle = function(req, res) {
	var commitHash = req.query.commit;
	var commitDate = new Date(req.query.ctime);
	var knownCommit = knownCommits && knownCommits[ commitHash ];

	req.connection.setTimeout(300 * 1000);
	res.setHeader('Content-Type', 'text/plain; charset=UTF-8');

	// Keep track of known commits so we can discard clients still on older
	// versions. If we don't know about the commit, then record it
	// Use a transaction to make sure we don't start fetching pages until
	// we've done this
	if (!knownCommit) {
		var trans = db.startTransaction();
		if (!knownCommits) {
			knownCommits = {};
			trans.query(dbCommitHashes, null, function(err, resCommitHashes) {
				if (err) {
					console.log('Error fetching known commits', err);
				} else {
					resCommitHashes.forEach(function(v) {
						knownCommits[v.hash] = commitDate;
					});
				}
			});
		}

		// New commit, record it
		knownCommits[ commitHash ] = commitDate;
		trans.query(dbInsertCommit, [ commitHash, new Date() ], function(err, commitInsertResult) {
			if (err) {
				console.error("Error inserting commit " + commitHash);
			} else if (commitInsertResult.affectedRows > 0) {
				// If this is a new commit, we need to clear the number of times a
				// crasher page has been sent out so that each title gets retested
				trans.query(dbUpdateCrashersClearTries, [ commitHash, maxTries ]);
			}
		});

		trans.commit();
	}
	if (knownCommit && commitHash !== lastFetchedCommit) {
		// It's an old commit, tell the client so it can restart.
		// HTTP status code 426 Update Required
		res.send("Old commit", 426);
		return;
	}

	var fetchCb = function(err, pages) {
		if (err) {
			res.send("Error: " + err.toString(), 500);
			return;
		}

		if (pages) {
			// Get the pages that aren't already fetched, to guard against the
			// case of clients not finishing the whole batch in the cutoff time
			var newPages = pages.filter(function(p) {
				return fetchedPages.every(function(f) {
					return f.id !== p.id;
				});
			});
			// Append the new pages to the already fetched ones, in case there's
			// a parallel request.
			fetchedPages = fetchedPages.concat(newPages);
		}
		if (fetchedPages.length === 0) {
			// Send 404 to indicate no pages available now, clients depend on
			// this.
			res.send('No available titles that fit the constraints.', 404);
		} else {
			var page = fetchedPages.pop();

			console.log(' ->', page.prefix + ':' + page.title);
			res.send(page, 200);
		}
	};

	// Look if there's a title available in the already fetched ones.
	// Ensure that we load a batch when the commit has changed.
	if (fetchedPages.length === 0 ||
			commitHash !== lastFetchedCommit ||
			(lastFetchedDate.getTime() + (cutOffTime * 1000)) < Date.now()) {
		// Select pages that were not claimed in the 10 minutes.
		// If we didn't get a result from a client 10 minutes after
		// it got a rt claim on a page, something is wrong with the client
		// or with parsing the page.
		//
		// Hopefully, no page takes longer than 10 minutes to parse. :)

		lastFetchedCommit = commitHash;
		lastFetchedDate = new Date();
		fetchPages(commitHash, new Date(Date.now() - (cutOffTime * 1000)), fetchCb);
	} else {
		fetchCb();
	}
};

var statsScore = function(skipCount, failCount, errorCount) {
	// treat <errors,fails,skips> as digits in a base 1000 system
	// and use the number as a score which can help sort in topfails.
	return errorCount * 1000000 + failCount * 1000 + skipCount;
};

var transUpdateCB = function(title, prefix, hash, type, res, trans, successCb, err, result) {
	if (err) {
		trans.rollback();
		var msg = "Error inserting/updating " + type + " for page: " +  prefix + ':' + title + " and hash: " + hash;
		console.error(msg);
		console.error(err);
		if (res) {
			res.send(msg, 500);
		}
	} else if (successCb) {
		successCb(result);
	}
};

var receiveResults = function(req, res) {
	req.connection.setTimeout(300 * 1000);
	var title = req.params[0];
	var prefix = req.params[1];
	var commitHash = req.body.commit;
	var result = req.body.results;
	var skipCount;
	var failCount;
	var errorCount;
	var dneError;

	var contentType = req.headers["content-type"];
	var resultString;
	if (contentType.match(/application\/json/i)) {
		// console.warn("application/json");
		errorCount = result.err ? 1 : 0;
		failCount = parseInt(result.fails || "0");
		skipCount = parseInt(result.skips || "0");
		resultString = JSON.stringify(result);
	} else {
		// console.warn("old xml junit style");
		errorCount = result.match(/<error/g);
		errorCount = errorCount ? errorCount.length : 0;
		skipCount = result.match(/<skipped/g);
		skipCount = skipCount ? skipCount.length : 0;
		failCount = result.match(/<failure/g);
		failCount = failCount ? failCount.length : 0;
		dneError = result.match('DoesNotExist');
		resultString = result;
	}

	// Find the number of selser errors
	var selserErrorCount = parsoidRTConfig ? parsoidRTConfig.parseSelserStats(result) : 0;

	// Get perf stats
	var perfstats = perfConfig ? perfConfig.parsePerfStats(result) : null;

	res.setHeader('Content-Type', 'text/plain; charset=UTF-8');

	var trans = db.startTransaction();
	// console.warn("got: " + JSON.stringify([title, commitHash, result, skipCount, failCount, errorCount]));
	if (errorCount > 0 && dneError) {
		// Page fetch error, increment the fetch error count so, when it goes
		// over maxFetchRetries, it won't be considered for tests again.
		console.log('XX', prefix + ':' + title);
		trans.query(dbIncrementFetchErrorCount, [commitHash, title, prefix],
			transUpdateCB.bind(null, title, prefix, commitHash, "page fetch error count", res, trans, null))
			.commit(function(err) {
				if (err) {
					console.error("Error incrementing fetch count: " + err.toString());
				}
				res.send('', 200);
			});

	} else {
		trans.query(dbFindPage, [ title, prefix ], function(err, pages) {
			if (!err && pages.length === 1) {
				// Found the correct page, fill the details up
				var page = pages[0];

				var score = statsScore(skipCount, failCount, errorCount);
				var latestResultId = 0;
				var latestStatId = 0;
				// Insert the result
				trans.query(dbInsertResult, [ page.id, commitHash, resultString ],
					transUpdateCB.bind(null, title, prefix, commitHash, "result", res, trans, function(insertedResult) {
						latestResultId = insertedResult.insertId;
						// Insert the stats
						trans.query(dbInsertStats, [ skipCount, failCount, errorCount, selserErrorCount, score, page.id, commitHash ],
							transUpdateCB.bind(null, title, prefix, commitHash, "stats", res, trans, function(insertedStat) {
								latestStatId = insertedStat.insertId;

								// And now update the page with the latest info
								trans.query(dbUpdatePageLatestResults, [ latestStatId, score, latestResultId, commitHash, page.id ],
									transUpdateCB.bind(null, title, prefix, commitHash, "latest result", res, trans, function() {
										trans.commit(function() {
											console.log('<- ', prefix + ':' + title, ':', skipCount, failCount,
												errorCount, commitHash.substr(0, 7));

											if (perfConfig) {
												// Insert the performance stats, ignoring errors for now
												perfConfig.insertPerfStats(db, page.id, commitHash, perfstats, null);
											}

											// Maybe the perfstats aren't committed yet, but it shouldn't be a problem
											res.send('', 200);
										});
									}));
							}));
					}));
			} else {
				trans.rollback(function() {
					if (err) {
						res.send(err.toString(), 500);
					} else {
						res.send("Did not find claim for title: " + prefix + ':' + title, 200);
					}
				});
			}
		}).execute();
	}
};

// block helper to reference js files in page head.
// options.fn is a function taking the present context and returning a string
// (whatever is between {{#jsFiles}} and {{/jsFiles}} in a template).
// This string becomes the value of a 'javascripts' key added to the context, to be
// rendered as html where {{{javascripts}}} appears in layout.html.
hbs.registerHelper('jsFiles', function(options) {
	if (!this.javascripts) {
		this.javascripts = {};
	}
	this.javascripts = options.fn(this);
	return null;
});

var pageListData = [
	{ url: 'topfails', title: 'Results by title' },
	{ url: 'failedFetches', title: 'Non-existing test pages' },
	{ url: 'failsDistr', title: 'Histogram of failures' },
	{ url: 'skipsDistr', title: 'Histogram of skips' },
	{ url: 'commits', title: 'List of all tested commits' },
];

if (perfConfig) {
	perfConfig.updateIndexPageUrls(pageListData);
}

if (parsoidRTConfig) {
	parsoidRTConfig.updateIndexPageUrls(pageListData);
}

hbs.registerHelper('formatPerfStat', function(type, value) {
	if (type.match(/^time/)) {
		// Show time in seconds
		value = Math.round((value / 1000) * 100) / 100;
		return value.toString() + "s";
	} else if (type.match(/^size/)) {
		// Show sizes in KiB
		value = Math.round(value / 1024);
		return value.toString() + "KiB";
	} else {
		// Other values go as they are
		return value.toString();
	}
});

var statsWebInterface = function(req, res) {
	var query, queryParams;
	var cutoffDate = new Date(Date.now() - (cutOffTime * 1000));
	var prefix = req.params[1] || null;

	// Switch the query object based on the prefix
	if (prefix !== null) {
		query = dbPerWikiStatsQuery;
		queryParams = [
			prefix, prefix, prefix, prefix,
			prefix, prefix, prefix, prefix,
			maxTries, cutoffDate, prefix, prefix,
		];
	} else {
		query = dbStatsQuery;
		queryParams = [ maxTries, cutoffDate ];
	}

	// Fetch stats for commit
	db.query(query, queryParams, function(err, row) {
		if (err) {
			res.send(err.toString(), 500);
			return;
		}

		res.status(200);

		var tests = row[0].total;
		var errorLess = row[0].no_errors;
		var skipLess = row[0].no_skips;
		var numRegressions = row[0].numregressions;
		var numFixes = row[0].numfixes;
		var noErrors = Math.round(100 * 100 * errorLess / (tests || 1)) / 100;
		var perfects = Math.round(100 * 100 * skipLess / (tests || 1)) / 100;
		var syntacticDiffs = Math.round(100 * 100 *
			(row[0].no_fails / (tests || 1))) / 100;

		var width = 800;

		var data = {
			prefix: prefix,
			results: {
				tests: tests,
				noErrors: noErrors,
				syntacticDiffs: syntacticDiffs,
				perfects: perfects,
			},
			graphWidths: {
				perfect: width * perfects / 100 || 0,
				syntacticDiff: width * (syntacticDiffs - perfects) / 100 || 0,
				semanticDiff: width * (100 - syntacticDiffs) / 100 || 0,
			},
			latestRevision: [
				{
					description: 'Git SHA1',
					value: row[0].maxhash,
				},
				{
					description: 'Test Results',
					value: row[0].maxresults,
				},
				{
					description: 'Crashers',
					value: row[0].crashers,
					url: 'crashers',
				},
				{
					description: 'Fixes',
					value: numFixes,
					url: 'topfixes/between/' + row[0].secondhash + '/' + row[0].maxhash,
				},
				{
					description: 'Regressions',
					value: numRegressions,
					url: 'regressions/between/' + row[0].secondhash + '/' + row[0].maxhash,
				},
			],
			averages: [
				{ description: 'Errors', value: row[0].avgerrors },
				{ description: 'Fails', value: row[0].avgfails },
				{ description: 'Skips', value: row[0].avgskips },
				{ description: 'Score', value: row[0].avgscore },
			],
			pages: pageListData,
		};

		if (perfConfig) {
			perfConfig.updateIndexData(data, row);
		}

		if (parsoidRTConfig) {
			parsoidRTConfig.updateIndexData(data, row);
			data.parsoidRT = true;
		}

		// round numeric data, but ignore others
		hbs.registerHelper('round', function(val) {
				if (isNaN(val)) {
					return val;
				} else {
					return Math.round(val * 100) / 100;
				}
			});

		res.render('index.html', data);
	});
};

var makeFailsRow = function(urlPrefix, row) {
	return [
		RH.pageTitleData(urlPrefix, row),
		RH.commitLinkData(urlPrefix, row.hash, row.title, row.prefix),
		row.skips,
		row.fails,
		row.errors === null ? 0 : row.errors,
	];
};

var failsWebInterface = function(req, res) {
	var page = (req.params[0] || 0) - 0;
	var offset = page * 40;
	var relativeUrlPrefix = (req.params[0] ? '../' : '');

	var data = {
		page: page,
		relativeUrlPrefix: relativeUrlPrefix,
		urlPrefix: relativeUrlPrefix + 'topfails',
		urlSuffix: '',
		heading: 'Results by title',
		header: ['Title', 'Commit', 'Syntactic diffs', 'Semantic diffs', 'Errors'],
	};
	db.query(dbFailsQuery, [ offset ],
		RH.displayPageList.bind(null, hbs, res, data, makeFailsRow));
};

var resultsWebInterface = function(req, res) {
	var query, queryParams;
	var prefix = req.params[1] || null;

	if (prefix !== null) {
		query = dbResultsPerWikiQuery;
		queryParams = [ prefix ];
	} else {
		query = dbResultsQuery;
		queryParams = [];
	}

	db.query(query, queryParams, function(err, rows) {
		if (err) {
			console.error(err);
			res.send(err.toString(), 500);
		} else {
			res.setHeader('Content-Type', 'text/xml; charset=UTF-8');
			res.status(200);
			res.write('<?xml-stylesheet href="/static/result.css"?>\n');
			res.write('<testsuite>');
			for (var i = 0; i < rows.length; i++) {
				res.write(rows[i].result);
				res.end('</testsuite>');
			}
		}
	});
};

var resultWebCallback = function(req, res, err, row) {
	if (err) {
		console.error(err);
		res.send(err.toString(), 500);
	} else if (row && row.length > 0) {
		if (row[0].result.match(/<testsuite/)) {
			res.setHeader('Content-Type', 'text/xml; charset=UTF-8');
			res.status(200);
			res.write('<?xml-stylesheet href="/static/result.css"?>\n');
		}
		res.end(row[0].result);
	} else {
		res.send('no results for that page at the requested revision', 200);
	}
};

var resultWebInterface = function(req, res) {
	var commit = req.params[2] ? req.params[0] : null;
	var title = commit === null ? req.params[1] : req.params[2];
	var prefix = commit === null ? req.params[0] : req.params[1];

	if (commit !== null) {
		db.query(dbGetResultWithCommit, [ commit, title, prefix ], resultWebCallback.bind(null, req, res));
	} else {
		db.query(dbGetOneResult, [ title, prefix ], resultWebCallback.bind(null, req, res));
	}
};

var getFailedFetches = function(req, res) {
	db.query(dbFailedFetches, [maxFetchRetries], function(err, rows) {
		if (err) {
			console.error(err);
			res.send(err.toString(), 500);
		} else {
			res.status(200);
			var n = rows.length;
			var pageData = [];
			for (var i = 0; i < n; i++) {
				var prefix = rows[i].prefix;
				var title = rows[i].title;
				var name = prefix + ':' + title;
				pageData.push({
					url: prefix.replace(/wiki$/, '') + '.wikipedia.org/wiki/' + title,
					linkName: name.replace('&', '&amp;'),
				});
			}
			var heading = n === 0 ? 'No titles returning 404!  All\'s well with the world!' :
				'The following ' + n + ' titles return 404';
			var data = {
				alt: n === 0,
				heading: heading,
				items: pageData,
			};
			hbs.registerHelper('formatUrl', function(url) {
				return 'http://' + encodeURI(url).replace('&', '&amp;');
			});
			res.render('list.html', data);
		}
	});
};

var getCrashers = function(req, res) {
	var cutoffDate = new Date(Date.now() - (cutOffTime * 1000));
	db.query(dbCrashers, [ maxTries, cutoffDate ], function(err, rows) {
		if (err) {
			console.error(err);
			res.send(err.toString(), 500);
		} else {
			res.status(200);
			var n = rows.length;
			var pageData = [];
			for (var i = 0; i < n; i++) {
				var prefix = rows[i].prefix;
				var title = rows[i].title;
				pageData.push({
					description: rows[i].claim_hash,
					url: prefix.replace(/wiki$/, '') + '.wikipedia.org/wiki/' + title,
					linkName: prefix + ':' + title,
				});
			}
			var heading = n === 0 ? 'No titles crash the testers! All\'s well with the world!' :
				'The following ' + n + ' titles crash the testers at least ' +
				maxTries + ' times ';
			var data = {
				alt: n === 0,
				heading: heading,
				items: pageData,
			};
			hbs.registerHelper('formatUrl', function(url) {
				return 'http://' + encodeURI(url).replace('&', '&amp;');
			});
			res.render('list.html', data);
		}
	});
};

var getFailsDistr = function(req, res) {
	db.query(dbFailsDistribution, null, function(err, rows) {
		if (err) {
			console.error(err);
			res.send(err.toString(), 500);
		} else {
			res.status(200);
			var n = rows.length;
			var intervalData = [];
			for (var i = 0; i < n; i++) {
				var r = rows[i];
				intervalData.push({ errors: r.fails, pages: r.num_pages });
			}
			var data = {
				heading: 'Distribution of semantic errors',
				interval: intervalData,
			};
			res.render('histogram.html', data);
		}
	});
};

var getSkipsDistr = function(req, res) {
	db.query(dbSkipsDistribution, null, function(err, rows) {
		if (err) {
			console.error(err);
			res.send(err.toString(), 500);
		} else {
			res.status(200);
			var n = rows.length;
			var intervalData = [];
			for (var i = 0; i < n; i++) {
				var r = rows[i];
				intervalData.push({errors: r.skips, pages: r.num_pages});
			}
			var data = {
				heading: 'Distribution of syntactic errors',
				interval: intervalData,
			};
			res.render('histogram.html', data);
		}
	});
};

var getRegressions = function(req, res) {
	var r1 = req.params[0];
	var r2 = req.params[1];
	var page = (req.params[2] || 0) - 0;
	var offset = page * 40;
	var relativeUrlPrefix = '../../../';
	relativeUrlPrefix = relativeUrlPrefix + (req.params[0] ? '../' : '');
	db.query(dbNumRegressionsBetweenRevs, [ r2, r1 ], function(err, row) {
		if (err) {
			res.send(err.toString(), 500);
		} else {
			var data = {
				page: page,
				relativeUrlPrefix: relativeUrlPrefix,
				urlPrefix: relativeUrlPrefix + 'regressions/between/' + r1 + '/' + r2,
				urlSuffix: '',
				heading: "Total regressions between selected revisions: " +
					row[0].numRegressions,
				headingLink: [{url: relativeUrlPrefix + 'topfixes/between/' + r1 + '/' + r2, name: 'topfixes'}],
				header: RH.regressionsHeaderData,
			};
			db.query(dbRegressionsBetweenRevs, [ r2, r1, offset ],
				RH.displayPageList.bind(null, hbs, res, data, RH.makeRegressionRow));
		}
	});
};

var getTopfixes = function(req, res) {
	var r1 = req.params[0];
	var r2 = req.params[1];
	var page = (req.params[2] || 0) - 0;
	var offset = page * 40;
	var relativeUrlPrefix = '../../../';
	relativeUrlPrefix = relativeUrlPrefix + (req.params[0] ? '../' : '');
	db.query(dbNumFixesBetweenRevs, [ r2, r1 ], function(err, row) {
		if (err) {
			res.send(err.toString(), 500);
		} else {
			var data = {
				page: page,
				relativeUrlPrefix: relativeUrlPrefix,
				urlPrefix: relativeUrlPrefix + 'topfixes/between/' + r1 + '/' + r2,
				urlSuffix: '',
				heading: 'Total fixes between selected revisions: ' + row[0].numFixes,
				headingLink: [{url: relativeUrlPrefix + "regressions/between/" + r1 + "/" + r2, name: 'regressions'}],
				header: RH.regressionsHeaderData,
			};
			db.query(dbFixesBetweenRevs, [ r2, r1, offset ],
				RH.displayPageList.bind(null, hbs, res, data, RH.makeRegressionRow));
		}
	});
};

var getCommits = function(req, res) {
	db.query(dbCommits, null, function(err, rows) {
		if (err) {
			console.error(err);
			res.send(err.toString(), 500);
		} else {
			res.status(200);
			var n = rows.length;
			var tableRows = [];
			for (var i = 0; i < n; i++) {
				var row = rows[i];
				var tableRow = {hash: row.hash, timestamp: row.timestamp};
				if (i + 1 < n) {
					tableRow.regUrl = 'regressions/between/' + rows[i + 1].hash + '/' + row.hash;
					tableRow.fixUrl = 'topfixes/between/' + rows[i + 1].hash + '/' + row.hash;
				}
				tableRows.push(tableRow);
			}
			var data = {
				numCommits: n,
				latest: n ? rows[n - 1].timestamp.toString().slice(4, 15) : '',
				header: ['Commit hash', 'Timestamp', 'Tests', '-', '+'],
				row: tableRows,
			};

			hbs.registerHelper('formatHash', function(hash) {
				return hash.slice(0, 10);
			});
			hbs.registerHelper('formatDate', function(timestamp) {
				return timestamp.toString().slice(4, 21);
			});

			res.render('commits.html', data);
		}
	});
};

var diffResultWebCallback = function(req, res, flag, err, row) {
	if (err) {
		console.error(err);
		res.send(err.toString(), 500);
	} else if (row.length === 2) {
		var oldCommit = req.params[0].slice(0, 10);
		var newCommit = req.params[1].slice(0, 10);
		var oldResult = row[0].result;
		var newResult = row[1].result;
		var flagResult = Diff.resultFlagged(oldResult, newResult, oldCommit, newCommit, flag);
		res.setHeader('Content-Type', 'text/xml; charset=UTF-8');
		res.status(200);
		res.write('<?xml-stylesheet href="/static/result.css"?>\n');
		res.end(flagResult);
	} else {
		var commit = flag === '+' ? req.params[1] : req.params[0];
		res.redirect('/result/' + commit + '/' + req.params[2] + '/' + req.params[3]);
	}
};

var resultFlagNewWebInterface = function(req, res) {
	var oldCommit = req.params[0];
	var newCommit = req.params[1];
	var prefix = req.params[2];
	var title = req.params[3];

	db.query(dbGetTwoResults, [ title, prefix, oldCommit, newCommit ],
		diffResultWebCallback.bind(null, req, res, '+'));
};

var resultFlagOldWebInterface = function(req, res) {
	var oldCommit = req.params[0];
	var newCommit = req.params[1];
	var prefix = req.params[2];
	var title = req.params[3];

	db.query(dbGetTwoResults, [ title, prefix, oldCommit, newCommit ],
		diffResultWebCallback.bind(null, req, res, '-'));
};

// Make an app
var app = express.createServer();

// Configure for Handlebars
app.configure(function() {
	app.set('view engine', 'handlebars');
	app.register('.html', require('handlebars'));
});

// Declare static directory
app.use("/static", express.static(__dirname + "/static"));

// Make the coordinator app
var coordApp = express.createServer();

// Add in the bodyParser middleware (because it's pretty standard)
app.use(express.bodyParser());
coordApp.use(express.bodyParser());

// robots.txt: no indexing.
app.get(/^\/robots\.txt$/, function(req, res) {
	res.end("User-agent: *\nDisallow: /\n");
});

// Main interface
app.get(/^\/results(\/([^\/]+))?$/, resultsWebInterface);

// Results for a title (on latest commit)
app.get(/^\/latestresult\/([^\/]+)\/(.*)$/, resultWebInterface);

// Results for a title on any commit
app.get(/^\/result\/([a-f0-9]*)\/([^\/]+)\/(.*)$/, resultWebInterface);

// List of failures sorted by severity
app.get(/^\/topfails\/(\d+)$/, failsWebInterface);
// 0th page
app.get(/^\/topfails$/, failsWebInterface);

// Overview of stats
app.get(/^\/$/, statsWebInterface);
app.get(/^\/stats(\/([^\/]+))?$/, statsWebInterface);

// Failed fetches
app.get(/^\/failedFetches$/, getFailedFetches);

// Crashers
app.get(/^\/crashers$/, getCrashers);

// Regressions between two revisions.
app.get(/^\/regressions\/between\/([^\/]+)\/([^\/]+)(?:\/(\d+))?$/, getRegressions);

// Topfixes between two revisions.
app.get(/^\/topfixes\/between\/([^\/]+)\/([^\/]+)(?:\/(\d+))?$/, getTopfixes);

// Results for a title on a commit, flag skips/fails new since older commit
app.get(/^\/resultFlagNew\/([a-f0-9]*)\/([a-f0-9]*)\/([^\/]+)\/(.*)$/, resultFlagNewWebInterface);

// Results for a title on a commit, flag skips/fails no longer in newer commit
app.get(/^\/resultFlagOld\/([a-f0-9]*)\/([a-f0-9]*)\/([^\/]+)\/(.*)$/, resultFlagOldWebInterface);

// Distribution of fails
app.get(/^\/failsDistr$/, getFailsDistr);

// Distribution of fails
app.get(/^\/skipsDistr$/, getSkipsDistr);

if (parsoidRTConfig) {
	parsoidRTConfig.setupEndpoints(settings, app, mysql, db, hbs);
}

if (perfConfig) {
	perfConfig.setupEndpoints(settings, app, mysql, db, hbs);
}

// List of all commits
app.get('/commits', getCommits);

// Clients will GET this path if they want to run a test
coordApp.get(/^\/title$/, getTitle);

// Receive results from clients
coordApp.post(/^\/result\/([^\/]+)\/([^\/]+)/, receiveResults);

// Start the app
var webappPort = settings.webappPort || 8001;
app.listen(webappPort, function() {
	console.log('Web app listening on: %s', webappPort);
});
coordApp.listen(settings.coordPort || 8002);
