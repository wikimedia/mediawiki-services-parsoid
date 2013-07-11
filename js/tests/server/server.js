#!/usr/bin/env node
( function () {
"use strict";

var http = require( 'http' ),
	express = require( 'express' ),
	dbStack = [], dbFlag = false,
	// The maximum number of tries per article
	maxTries = 6,
	// The maximum number of fetch retries per article
	maxFetchRetries = 6,
	// "Random" estimate of how many pending pages we have in the db
	pendingPagesEstimate = 500;

// Command line options
var argv = require( 'optimist' )
	.options( 'h', {
		alias: 'host',
		'default': 'localhost',
		describe: 'Hostname of the database server.'
	} )
	.options( 'P', {
		alias: 'port',
		'default': 3306,
		describe: 'Port number to use for connection.'
	} )
	.options( 'D', {
		alias: 'database',
		'default': 'parsoid',
		describe: 'Database to use.'
	} )
	.options( 'u', {
		alias: 'user',
		'default': 'parsoid',
		describe: 'User for login.'
	} )
	.options( 'p', {
		alias: 'password',
		'default': 'parsoidpw',
		describe: 'Password.'
	} )
	.argv;

var mysql = require( 'mysql' );
var db = mysql.createConnection({
	host     : argv.host,
	port     : argv.port,
	database : argv.database,
	user     : argv.user,
	password : argv.password,
	multipleStatements : true
});

db.connect();

var counter = 0;

// ----------------- The queries --------------
var dbGetTitle =
	'SELECT pages.id, pages.title, pages.prefix ' +
	'FROM pages ' +
	'LEFT JOIN claims ON pages.id = claims.page_id AND claims.commit_hash = ? ' +
	'LEFT JOIN stats ON stats.id = pages.latest_result ' +
	'WHERE num_fetch_errors < ? AND ' +
	'( claims.id IS NULL OR ' +
	'( claims.has_errorless_result = 0 AND claims.num_tries <= ? AND claims.timestamp < ? ) ) ' +
	'ORDER BY stats.score DESC, ' +
	'claims.timestamp ASC LIMIT 1 OFFSET ? ';

var dbFindTitleForClaim =
	'SELECT pages.id, pages.title, pages.prefix ' +
	'FROM pages, claims ' +
	'WHERE pages.id = ? AND pages.id = claims.page_id AND ' +
	'claims.commit_hash= ?';

var dbGetTitleRandom =
	'SELECT pages.id, pages.title, pages.prefix ' +
	'FROM pages ' +
	'LEFT JOIN claims ON pages.id = claims.page_id AND claims.commit_hash = ? ' +
	'LEFT JOIN stats ON stats.id = pages.latest_result ' +
	'WHERE num_fetch_errors < ? AND ' +
	'( claims.id IS NULL OR ' +
	'( claims.has_errorless_result = 0 AND claims.num_tries <= ? AND claims.timestamp < ? ) ) ' +
	'ORDER BY stats.score DESC, ' +
	'claims.timestamp ASC, RAND() LIMIT 1';

var dbIncrementFetchErrorCount =
	'UPDATE pages SET num_fetch_errors = num_fetch_errors + 1 WHERE title = ? AND prefix = ?';

var dbClearFetchErrorCount =
	'UPDATE pages SET num_fetch_errors = 0 WHERE title = ? and prefix = ?';

var dbInsertCommit =
	'INSERT IGNORE INTO commits ( hash, timestamp ) ' +
	'VALUES ( ?, ? )';

var dbFindClaimByPageId =
	'SELECT claims.id, claims.num_tries FROM claims ' +
	'WHERE claims.page_id = ? AND claims.commit_hash = ?';

var dbFindClaimByTitle =
	'SELECT claims.id, claims.num_tries, claims.page_id FROM claims ' +
	'JOIN pages ON pages.id = claims.page_id AND pages.title = ? AND pages.prefix = ? ' +
	'WHERE claims.commit_hash = ? AND claims.has_errorless_result = 0';

var dbInsertClaim =
	'INSERT INTO claims ( page_id, commit_hash, timestamp ) ' +
	'VALUES ( ?, ?, ? )';

var dbTryInsertClaim =
	'INSERT INTO claims ( page_id, commit_hash, timestamp ) ' +
	'VALUES ( ( ' +
	'SELECT pages.id ' +
	'FROM pages ' +
	'LEFT JOIN claims ON pages.id = claims.page_id AND claims.commit_hash = ? ' +
	'LEFT JOIN stats ON stats.id = pages.latest_result ' +
	'WHERE num_fetch_errors < ? AND ' +
	'( claims.id IS NULL OR ' +
	'( claims.has_errorless_result = 0 AND claims.num_tries <= ? AND claims.timestamp < ? ) ) ' +
	'ORDER BY stats.score DESC, ' +
	'claims.timestamp ASC LIMIT 1 ' +
	' ), ?, ? )';

var dbTryUpdateClaim =
	// the ids look redundant, but this is intended to atomically succeed, or fail if already recently reclaimed
	'UPDATE claims SET timestamp = ?, num_tries = num_tries + 1 WHERE id = ? AND id = (' +
	'SELECT pages.id ' +
	'FROM pages ' +
	'LEFT JOIN claims ON pages.id = claims.page_id AND claims.commit_hash = ? ' +
	'LEFT JOIN stats ON stats.id = pages.latest_result ' +
	'WHERE num_fetch_errors < ? AND ' +
	'( claims.id IS NULL OR ' +
	'( claims.has_errorless_result = 0 AND claims.num_tries <= ? AND claims.timestamp < ? ) ) ' +
	'ORDER BY stats.score DESC, ' +
	'claims.timestamp ASC LIMIT 1)';

var dbUpdateClaim =
	'UPDATE claims SET timestamp = ?, num_tries = num_tries + 1 WHERE id = ?';

var dbUpdateClaimResult =
	'UPDATE claims SET has_errorless_result = 1 WHERE id = ?';

var dbFindStatRow =
	'SELECT id FROM stats WHERE page_id = ? AND commit_hash = ?';

var dbInsertResult =
	'INSERT INTO results ( claim_id, result ) ' +
	'VALUES ( ?, ? )';

var dbUpdateResult =
	'UPDATE results SET result = ? WHERE claim_id = ?';

var dbInsertClaimStats =
	'INSERT INTO stats ' +
	'( skips, fails, errors, score, page_id, commit_hash ) ' +
	'VALUES ( ?, ?, ?, ?, ?, ? ) ';

var dbUpdateClaimStats =
	'UPDATE stats ' +
	'SET skips = ?, fails = ?, errors = ?, score = ? ' +
	'WHERE page_id = ? AND commit_hash = ?';

var dbUpdateLatestResult =
	'UPDATE pages ' +
	'SET latest_result = ( SELECT id from stats ' +
    'WHERE stats.commit_hash = ? AND page_id = pages.id ) ' +
    'WHERE id = ?';

var dbLatestCommitHash =
	'SELECT hash FROM commits ORDER BY timestamp DESC LIMIT 1';

var dbSecondLastCommitHash =
	'SELECT hash FROM commits ORDER BY timestamp DESC LIMIT 1 OFFSET 1';

// IMPORTANT: node-sqlite3 library has a bug where it seems to cache
// invalid results when a prepared statement has no variables.
// Without this dummy variable as a workaround for the caching bug,
// stats query always fails after the first invocation.  So, if you
// do upgrade the library, please test before removing this workaround.
var dbStatsQuery =
	'SELECT ? AS cache_bug_workaround, ' +
	'(select hash from commits order by timestamp desc limit 1) as maxhash, ' +
	'(select count(*) from stats where stats.commit_hash = ' +
		'(select hash from commits order by timestamp desc limit 1)) as maxresults, ' +
	'(select avg(stats.errors) from stats join pages on ' +
		'pages.latest_result = stats.id) as avgerrors, ' +
	'(select avg(stats.fails) from stats join pages on ' +
		'pages.latest_result = stats.id) as avgfails, ' +
	'(select avg(stats.skips) from stats join pages on ' +
		'pages.latest_result = stats.id) as avgskips, ' +
	'(select avg(stats.score) from stats join pages on ' +
		'pages.latest_result = stats.id) as avgscore, ' +
	'count(*) AS total, ' +
	'count(CASE WHEN stats.errors=0 THEN 1 ELSE NULL END) AS no_errors, ' +
	'count(CASE WHEN stats.errors=0 AND stats.fails=0 '+
		'then 1 else null end) AS no_fails, ' +
	'count(CASE WHEN stats.errors=0 AND stats.fails=0 AND stats.skips=0 '+
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
	'AND s1.score < s2.score ) as numfixes '  +

	'FROM pages JOIN stats on pages.latest_result = stats.id';

var dbPerWikiStatsQuery =
	'SELECT ? AS cache_bug_workaround, ' +
	'(select hash from commits order by timestamp desc limit 1) as maxhash, ' +
	'(select count(*) from stats join pages on stats.page_id = pages.id ' +
		'where stats.commit_hash = ' +
		'(select hash from commits order by timestamp desc limit 1) ' +
		'and pages.prefix = ?) as maxresults, ' +
	'(select avg(stats.errors) from stats join pages on ' +
		'pages.latest_result = stats.id where pages.prefix = ?) as avgerrors, ' +
	'(select avg(stats.fails) from stats join pages on ' +
		'pages.latest_result = stats.id where pages.prefix = ?) as avgfails, ' +
	'(select avg(stats.skips) from stats join pages on ' +
		'pages.latest_result = stats.id where pages.prefix = ?) as avgskips, ' +
	'(select avg(stats.score) from stats join pages on ' +
		'pages.latest_result = stats.id where pages.prefix = ?) as avgscore, ' +
	'count(*) AS total, ' +
	'count(CASE WHEN stats.errors=0 THEN 1 ELSE NULL END) AS no_errors, ' +
	'count(CASE WHEN stats.errors=0 AND stats.fails=0 '+
		'then 1 else null end) AS no_fails, ' +
	'count(CASE WHEN stats.errors=0 AND stats.fails=0 AND stats.skips=0 '+
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
	'AND s1.score < s2.score ) as numfixes ' +

	'FROM pages JOIN stats on pages.latest_result = stats.id WHERE pages.prefix = ?';

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
	'JOIN claims ON results.claim_id = claims.id ' +
	'JOIN commits ON claims.commit_hash = commits.hash ' +
	'JOIN pages ON pages.id = claims.page_id ' +
	'WHERE pages.title = ? AND pages.prefix = ? ' +
	'ORDER BY commits.timestamp DESC LIMIT 1' ;

var dbGetResultWithCommit =
    'SELECT result FROM results ' +
    'JOIN claims ON results.claim_id = claims.id ' +
    'AND claims.commit_hash = ? ' +
    'JOIN pages ON pages.id = claims.page_id ' +
    'WHERE pages.title = ? AND pages.prefix = ?';

var dbFailedFetches =
	'SELECT title, prefix FROM pages WHERE num_fetch_errors >= ?';

var dbRegressedPages =
	'SELECT pages.title, pages.prefix, ' +
	's1.commit_hash AS new_commit, s1.errors AS new_errors, s1.fails AS new_fails, s1.skips AS new_skips, ' +
	's2.commit_hash AS old_commit, s2.errors AS old_errors, s2.fails AS old_fails, s2.skips AS old_skips ' +
	'FROM pages ' +
	'JOIN stats AS s1 ON s1.id = pages.latest_result ' +
	'JOIN stats AS s2 ON s2.page_id = pages.id ' +
	'WHERE s2.id != s1.id AND s1.score > s2.score ' +
	'GROUP BY pages.id ' + // picks a "random" past hash from which we regressed
	'ORDER BY s1.score - s2.score DESC ' +
	'LIMIT 40 OFFSET ?';

var dbFixedPages =
	'SELECT pages.title, pages.prefix, ' +
	's1.commit_hash AS new_commit, s1.errors AS new_errors, s1.fails AS new_fails, s1.skips AS new_skips, ' +
	's2.commit_hash AS old_commit, s2.errors AS old_errors, s2.fails AS old_fails, s2.skips AS old_skips ' +
	'FROM pages ' +
	'JOIN stats AS s1 ON s1.id = pages.latest_result ' +
	'JOIN stats AS s2 ON s2.page_id = pages.id ' +
	'WHERE s2.id != s1.id AND s1.score < s2.score ' +
	'GROUP BY pages.id ' + // picks a "random" past hash from which we regressed
	'ORDER BY s1.score - s2.score ASC ' +
	'LIMIT 40 OFFSET ?';

var dbFailsDistribution =
	'SELECT ? AS caching_bug_workaround, fails, count(*) AS num_pages ' +
	'FROM stats ' +
	'JOIN pages ON pages.latest_result = stats.id ' +
	'GROUP by fails';

var dbSkipsDistribution =
	'SELECT ? AS caching_bug_workaround, skips, count(*) AS num_pages ' +
	'FROM stats ' +
	'JOIN pages ON pages.latest_result = stats.id ' +
	'GROUP by skips';

var dbCommits =
	'SELECT ? AS caching_bug_workaround, hash, timestamp, ' +
	//// get the number of fixes column
	//	'(SELECT count(*) ' +
	//	'FROM pages ' +
	//		'JOIN stats AS s1 ON s1.page_id = pages.id ' +
	//		'JOIN stats AS s2 ON s2.page_id = pages.id ' +
	//	'WHERE s1.commit_hash = (SELECT hash FROM commits c2 where c2.timestamp < c1.timestamp ORDER BY timestamp DESC LIMIT 1 ) ' +
	//		'AND s2.commit_hash = c1.hash AND s1.score < s2.score) as numfixes, ' +
	//// get the number of regressions column
	//	'(SELECT count(*) ' +
	//	'FROM pages ' +
	//		'JOIN stats AS s1 ON s1.page_id = pages.id ' +
	//		'JOIN stats AS s2 ON s2.page_id = pages.id ' +
	//	'WHERE s1.commit_hash = (SELECT hash FROM commits c2 where c2.timestamp < c1.timestamp ORDER BY timestamp DESC LIMIT 1 ) ' +
	//		'AND s2.commit_hash = c1.hash AND s1.score > s2.score) as numregressions, ' +
	//// get the number of tests for this commit column
		'(select count(*) from stats where stats.commit_hash = c1.hash) as numtests ' +
	'FROM commits c1 ' +
	'ORDER BY timestamp DESC';

var dbFixesBetweenRevs =
	'SELECT pages.title, pages.prefix, ' +
	's1.commit_hash AS new_commit, s1.errors AS new_errors, s1.fails AS new_fails, s1.skips AS new_skips, ' +
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
	's1.commit_hash AS new_commit, s1.errors AS new_errors, s1.fails AS new_fails, s1.skips AS new_skips, ' +
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

var dbNumRegressionsBetweenLastTwoRevs =
	'SELECT count(*) as numRegressions ' +
	'FROM pages ' +
	'JOIN stats AS s1 ON s1.page_id = pages.id ' +
	'JOIN stats AS s2 ON s2.page_id = pages.id ' +
	'WHERE s1.commit_hash = (SELECT hash ' +
	                        'FROM commits ORDER BY timestamp DESC LIMIT 1 ) ' +
        'AND s2.commit_hash = (SELECT hash ' +
                              'FROM commits ORDER BY timestamp DESC LIMIT 1 OFFSET 1) ' +
        'AND s1.score > s2.score ';

var dbResultsQuery =
	'SELECT result FROM results'
;

var dbResultsPerWikiQuery =
	'SELECT result FROM results ' +
	'JOIN claims ON claims.id = results.claim_id ' +
	'JOIN pages ON pages.id = claims.page_id ' +
	'WHERE pages.prefix = ?'
;

var dbUpdateErrCB = function(title, prefix, hash, type, msg, err) {
	if (err) {
		console.error("Error inserting/updating", type, "for page:", prefix + ':' + title, "and hash:", hash);
		if (msg) {
			console.error(msg);
		}
		console.error("ERR:", err);
	}
};

var titleCallback = function( req, res, retry, commitHash, cutOffTimestamp, err, row ) {
	if ( err && !retry ) {
		console.error( 'Error in titleCallback: ' + err.toString() );
		res.send( 'Error! ' + err.toString(), 500 );
	} else if ( err === null && row && row.length > 0 ) {
		// SSS FIXME: what about error checks?
		db.query( dbInsertCommit, [ commitHash, decodeURIComponent( req.query.ctime ) ] );
		db.query( dbFindClaimByPageId, [ row[0].id, commitHash ], function ( err, claim ) {
			if ( claim && claim[0] ) {
				// Ignoring possible duplicate processing
				// Increment the # of tries, update timestamp
				db.query( dbUpdateClaim, [Date.now(), claim[0].id],
					dbUpdateErrCB.bind(null, row[0].title, row[0].prefix, commitHash, "claim", null));

				if (claim[0].num_tries >= maxTries) {
					// Too many failures.  Insert an error stats entry and retry fetch
					console.log( ' CRASHER?', row[0].prefix + ':' + row[0].title );
					var stats = [0, 0, 1, statsScore(0,0,1), claim[0].page_id, commitHash];
					db.query( dbInsertClaimStats, stats, function ( err ) {
						if (err) {
							// Try updating the stats instead of inserting if we got an error
							// Likely a sql constraint error
							db.query( dbUpdateClaimStats, stats, function (err) {
								dbUpdateErrCB( row[0].title, row[0].prefix, commitHash, 'stats', null, err );
							});
						}
					} );
					fetchPage(commitHash, cutOffTimestamp, req, res);
				} else {
					console.log( ' ->', row[0].prefix + ':' + row[0].title );
					res.send( { prefix: row[0].prefix, title: row[0].title } );
				}
			} else {
				// Claim doesn't exist
				db.query( dbInsertClaim, [ row[0].id, commitHash, Date.now() ], function(err) {
					if (!err) {
						console.log( ' ->', row[0].prefix + ':' + row[0].title );
						res.send( { prefix: row[0].prefix, title: row[0].title } );
					} else {
						console.error(err);
						console.error("Multiple clients trying to access the same title:", row[0].prefix + ':' + row[0].title );
						// In the rare scenario that some other client snatched the
						// title before us, get a new title (use the randomized ordering query)
						db.query( dbGetTitleRandom, [ commitHash, maxFetchRetries, maxTries, cutOffTimestamp ],
							titleCallback.bind( null, req, res, false, commitHash, cutOffTimestamp ) );
					}
				});
			}
		});
	} else if ( retry ) {
		// Try again with the slow DB search method
		db.query( dbGetTitleRandom, [ commitHash, maxFetchRetries, maxTries, cutOffTimestamp ],
			titleCallback.bind( null, req, res, false, commitHash, cutOffTimestamp ) );
	} else {
		res.send( 'no available titles that fit those constraints', 404 );
	}
};

var fetchPage = function( commitHash, cutOffTimestamp, req, res ) {
	// This query picks a random page among the first 'pendingPagesEstimate' pages
	var rowOffset = Math.floor(Math.random() * pendingPagesEstimate);
	db.query( dbGetTitle, [ commitHash, maxFetchRetries, maxTries, cutOffTimestamp, rowOffset ],
		titleCallback.bind( null, req, res, true, commitHash, cutOffTimestamp ) );
};


var claimPage = function( commitHash, cutOffTimestamp, req, res ) {
	// rather than getting a title then trying to claim it, atomically claim then fetch the matching title
/*
	db.query(
		'start transaction;' +
		"insert into pages(title) values ('Foo30');" +
		"insert into pages(title) values ('Foo31');" +
		"insert into pages(title) values ('Foo26');" +
		'COMMIT; '
		, [], function(err) { db.query('rollback', [], function(err){}); if( err ) console.error( err ); } );
*/
	db.query( 'START TRANSACTION;', [], function( err ) {
		if ( err ) {
			console.error( err );
		}
	} );
	db.query( dbGetTitle, [ commitHash, maxFetchRetries, maxTries, cutOffTimestamp, 0 ], function( err, row ) {
		if ( err ) {
			console.error( err );
			console.error( "Failed fetching row to update (" + [ cutOffTimestamp, commitHash, maxFetchRetries, maxTries, Date.now() ] + ')' );
		} else {
			console.log(row[0].title);
			var targetID = row[0].id;
			console.log( 'Trying insert of ' + targetID + ' with ' + [ Date.now(), targetID ]);
			db.query( dbInsertClaim, [ targetID, commitHash, Date.now() ], function(err) {
				if ( err ) {
					db.query( 'ROLLBACK;', [], function(err){});
					console.error( err );
					console.error( "Failed updating with (" + [ Date.now(), targetID ] + ')' );
				} else {
					db.query( 'COMMIT;', [], function(err){});
					console.log( 'Update succeeded.  Get detail ' + [targetID, commitHash ] );

					// success get the updated id and fetch the detail to match
					db.query( dbFindTitleForClaim, [ targetID, commitHash ], function( err, row ) {
						console.log("XXXX" +  err + row );
						if ( !err ) {
							console.log( row );
							console.log( ' ->', row[0].prefix + ':' + row[0].title + ' (updated)' );
							res.send( { prefix: row[0].prefix, title: row[0].title } );
						} else {
							console.error( err );
							console.error( "Failed getting the title to match the update " + this.lastID );
						}
					});
				}
			});
		}
	});
};


var getTitle = function ( req, res ) {
	res.setHeader( 'Content-Type', 'text/plain; charset=UTF-8' );

	// Select pages that were not claimed in the 10 minutes.
	// If we didn't get a result from a client 10 minutes after
	// it got a rt claim on a page, something is wrong with the client
	// or with parsing the page.
	//
	// Hopefully, no page takes longer than 10 minutes to parse. :)

	// claimPage(req.query.commit, Date.now() - 600, req, res);

	fetchPage(req.query.commit, Date.now() - 600, req, res);
};

var statsScore = function(skipCount, failCount, errorCount) {
	// treat <errors,fails,skips> as digits in a base 1000 system
	// and use the number as a score which can help sort in topfails.
	return errorCount*1000000+failCount*1000+skipCount;
};

var receiveResults = function ( req, res ) {
	var title = decodeURIComponent( req.params[0] ),
		result = req.body.results,
		skipCount = result.match( /<skipped/g ),
		failCount = result.match( /<failure/g ),
		errorCount = result.match( /<error/g );
	var prefix = req.params[1];

	skipCount = skipCount ? skipCount.length : 0;
	failCount = failCount ? failCount.length : 0;
	errorCount = errorCount ? errorCount.length : 0;

	res.setHeader( 'Content-Type', 'text/plain; charset=UTF-8' );

	var commitHash = req.body.commit;
	//console.warn("got: " + JSON.stringify([title, commitHash, result, skipCount, failCount, errorCount]));
	if ( errorCount > 0 && result.match( 'DoesNotExist' ) ) {
		console.log( 'XX', prefix + ':' + title );
		db.query( dbIncrementFetchErrorCount, [title, prefix],
			dbUpdateErrCB.bind(null, title, prefix, commitHash, "page fetch error count", null));

		// NOTE: the last db update may not have completed yet
		// For now, always sending HTTP 200 back to client.
		res.send( '', 200 );
	} else {
		db.query( dbFindClaimByTitle, [ title, prefix, commitHash ], function ( err, claim ) {
			if ( !err && claim && claim.length > 0 ) {
				db.query( dbClearFetchErrorCount, [title, prefix],
					dbUpdateErrCB.bind(null, title, prefix, commitHash, "page fetch error count", null));

				// Insert/update result and stats depending on whether this was
				// the first try or a subsequent retry -- prevents duplicates
				db.query( dbInsertResult, [claim[0].id, result],
					dbUpdateErrCB.bind(null, title, prefix, commitHash, "result", null));

				var stats = [skipCount, failCount, errorCount, statsScore(skipCount,failCount,errorCount)];
				db.query( dbInsertClaimStats, stats.concat([claim[0].page_id, commitHash]), function ( err ) {
					if ( err ) {
						dbUpdateErrCB( title, prefix, commitHash, 'stats', null, err );
					} else {
						db.query( dbUpdateLatestResult, [commitHash, claim[0].page_id],
							dbUpdateErrCB.bind(null, title, prefix, commitHash, 'latest result', null ) );
					}
				} );

				// Mark the claim as having a result. Used to be
				// error-free result, but now we are using it to track if
				// we have a result already.
				db.query( dbUpdateClaimResult, [claim[0].id],
					dbUpdateErrCB.bind(null, title, prefix, commitHash, "claim result", null));


				console.log( '<- ', prefix + ':' + title, ':', skipCount, failCount,
						errorCount, commitHash.substr(0,7) );
				// NOTE: the last db update may not have completed yet
				// For now, always sending HTTP 200 back to client.
				res.send( '', 200 );
			} else {
				var msg = "Did not find claim for title: " + prefix + ':' + title;
				msg = err ? msg + "\n" + err.toString() : msg;
				res.send(msg, 500);
			}
		} );
	}
};

var indexLinkList = function () {
	return '<p>More details:</p>\n<ul>' +
		'<li><a href="/topfails">Results by title</a></li>\n' +
		'<li><a href="/regressions">Top regressions</a></li>\n' +
		'<li><a href="/topfixes">Top fixes</a></li>\n' +
		'<li><a href="/failedFetches">Non-existing test pages</a></li>\n' +
		'<li><a href="/failsDistr">Histogram of failures</a></li>\n' +
		'<li><a href="/skipsDistr">Histogram of skips</a></li>\n' +
		'<li><a href="/commits">List of all tested commits</a></li>\n' +
		'</ul>';
};

var statsWebInterface = function ( req, res ) {
	var query, queryParams, prefix;

	var displayRow = function( res, label, val ) {
			// round numeric data, but ignore others
			if( !isNaN( Math.round( val * 100 ) / 100 ) ) {
				val = Math.round( val * 100 ) / 100;
			}
			res.write( '<tr style="font-weight:bold"><td style="padding-left:20px;">' + label );
			if ( prefix !== null ) {
				res.write( ' (' + prefix + ')' );
			}
			res.write( '</td><td style="padding-left:20px; text-align:right">' + val + '</td></tr>' );
	};

	prefix = req.params[1] || null;

	// Switch the query object based on the prefix
	if ( prefix !== null ) {
		query = dbPerWikiStatsQuery;
		queryParams = [ -1, prefix, prefix, prefix, prefix,
		                prefix, prefix, prefix, prefix ];
	} else {
		query = dbStatsQuery;
		queryParams = [ -1 ];
	}

	// Fetch stats for commit
	db.query( query, queryParams, function ( err, row ) {
		if ( err || !row ) {
			var msg = "Stats query returned nothing!";
			msg = err ? msg + "\n" + err.toString() : msg;
			console.error("Error: " + msg);
			res.send( msg, 500 );
		} else {
			res.setHeader( 'Content-Type', 'text/html; charset=UTF-8' );
			res.status( 200 );
			res.write( '<html><body>' );

			var tests = row[0].total,
			errorLess = row[0].no_errors,
			skipLess = row[0].no_skips,
			numRegressions = row[0].numregressions,
			numFixes = row[0].numfixes,
			noErrors = Math.round( 100 * 100 * errorLess / ( tests || 1 ) ) / 100,
			perfects = Math.round( 100* 100 * skipLess / ( tests || 1 ) ) / 100,
			syntacticDiffs = Math.round( 100 * 100 *
				( row[0].no_fails / ( tests || 1 ) ) ) / 100;

			res.write( '<p>We have run roundtrip-tests on <b>' +
				tests +
				'</b> articles, of which <ul><li><b>' +
				noErrors +
				'%</b> parsed without crashes </li><li><b>' +
				syntacticDiffs +
				'%</b> round-tripped without semantic differences, and </li><li><b>' +
				perfects +
				'%</b> round-tripped with no character differences at all.</li>' +
				'</ul></p>' );

			var width = 800;

			res.write( '<table><tr height=60px>');
			res.write( '<td width=' +
					( width * perfects / 100 || 0 ) +
					'px style="background:green" title="Perfect / no diffs"></td>' );
			res.write( '<td width=' +
					( width * ( syntacticDiffs - perfects ) / 100 || 0 ) +
					'px style="background:yellow" title="Syntactic diffs"></td>' );
			res.write( '<td width=' +
					( width * ( 100 - syntacticDiffs ) / 100 || 0 ) +
					'px style="background:red" title="Semantic diffs"></td>' );
			res.write( '</tr></table>' );

			res.write( '<p>Latest revision:' );
			res.write( '<table><tbody>');
			displayRow(res, "Git SHA1", row[0].maxhash);
			displayRow(res, "Test Results", row[0].maxresults);
			displayRow(res, "Regressions", numRegressions);
			displayRow(res, "Fixes", numFixes);
			res.write( '</tbody></table></p>' );

			res.write( '<p>Averages (over the latest results):' );
			res.write( '<table><tbody>');
			displayRow(res, "Errors", row[0].avgerrors);
			displayRow(res, "Fails", row[0].avgfails);
			displayRow(res, "Skips", row[0].avgskips);
			displayRow(res, "Score", row[0].avgscore);
			res.write( '</tbody></table></p>' );
			res.write( indexLinkList() );

			res.end( '</body></html>' );
		}
	});
};

var failsWebInterface = function ( req, res ) {
	if ( req.params[0] ) {
		console.log( 'GET /topfails/' + req.params[0] );
	} else {
		console.log( 'GET /topfails' );
	}

	var page = ( req.params[0] || 0 ) - 0,
		offset = page * 40;

	db.query( dbFailsQuery, [ offset ],
		function ( err, rows ) {
			var i, row;

			if ( err ) {
				res.send( err.toString(), 500 );
			} else if ( rows.length <= 0 ) {
				res.send( 'No entries found', 404 );
			} else {
				res.setHeader( 'Content-Type', 'text/html; charset=UTF-8' );
				res.status( 200 );
				res.write( '<html><body>' );

				res.write( '<p>' );
				if ( page > 0 ) {
					res.write( '<a href="/topfails/' + ( page - 1 ) + '">Previous</a> | ' );
				} else {
					res.write( 'Previous | ' );
				}
				res.write( '<a href="/topfails/' + ( page + 1 ) + '">Next</a>' );
				res.write( '</p>' );

				res.write( '<table><tr><th>Title</th><th>Commit</th><th>Syntactic diffs</th><th>Semantic diffs</th><th>Errors</th></tr>' );

				for ( i = 0; i < rows.length; i++ ) {
					res.write( '<tr><td style="padding-left: 0.4em; border-left: 5px solid ' );
					row = rows[i];

					if ( row['stats.skips'] === 0 && row['stats.fails'] === 0 && row['stats.errors'] === 0 ) {
						res.write( 'green' );
					} else if ( row['stats.errors'] > 0 ) {
						res.write( 'red' );
					} else if ( row['stats.fails'] === 0 ) {
						res.write( 'orange' );
					} else {
						res.write( 'red' );
					}

					res.write( '"><a target="_blank" href="http://parsoid.wmflabs.org/_rt/' + row.prefix + '/' +
						row.title + '">' +
						row.prefix + ':' + row.title + '</a> | ' +
						'<a target="_blank" href="http://localhost:8000/_rt/' + row.prefix + '/' + row.title +
						'">@lh</a> | ' +
						'<a target="_blank" href="/latestresult/' + row.prefix + '/' + row.title + '">latest result</a>' +
						'</td>' );
					res.write( '<td>' + makeCommitLink( row.hash, row.title, row.prefix ) + '</td>' );
					res.write( '<td>' + row.skips + '</td><td>' + row.fails + '</td><td>' + ( row.errors === null ? 0 : row.errors ) + '</td></tr>' );
				}
				res.end( '</table></body></html>' );
			}
		}
	);
};

var resultsWebInterface = function ( req, res ) {
	var query, queryParams,
		prefix = req.params[1] || null;

	if ( prefix !== null ) {
		query = dbResultsPerWikiQuery;
		queryParams = [ prefix ];
	} else {
		query = dbResultsQuery;
		queryParams = [];
	}

	db.query( query, queryParams, function ( err, rows ) {
		var i;
		if ( err ) {
			console.error( err );
			res.send( err.toString(), 500 );
		} else {
			if ( rows.length === 0 ) {
				res.send( '', 404 );
			} else {
				res.setHeader( 'Content-Type', 'text/xml; charset=UTF-8' );
				res.status( 200 );
				res.write( '<?xml-stylesheet href="/static/result.css"?>\n' );
				res.write( '<testsuite>' );
				for ( i = 0; i < rows.length; i++ ) {
					res.write( rows[i].result );
				}

				res.end( '</testsuite>' );
			}
		}
	} );
};

var resultWebCallback = function( req, res, err, row ) {
	if ( err ) {
		console.error( err );
		res.send( err.toString(), 500 );
	} else if ( row ) {
		res.setHeader( 'Content-Type', 'text/xml; charset=UTF-8' );
		res.status( 200 );
		res.write( '<?xml-stylesheet href="/static/result.css"?>\n' );
		res.end( row[0].result );
	} else {
		res.send( 'no results for that page at the requested revision', 404 );
	}
};

var resultWebInterface = function( req, res ) {
	var commit = req.params[2] ? req.params[0] : null;
	var title = commit === null ? req.params[1] : req.params[2];
	var prefix = commit === null ? req.params[0] : req.params[1];

	if ( commit !== null ) {
		db.query( dbGetResultWithCommit, [ commit, title, prefix ], resultWebCallback.bind( null, req, res ) );
	} else {
		db.query( dbGetOneResult, [ title, prefix ], resultWebCallback.bind( null, req, res ) );
	}
};

var GET_failedFetches = function( req, res ) {
	db.query( dbFailedFetches, [maxFetchRetries], function ( err, rows ) {
		if ( err ) {
			console.error( err );
			res.send( err.toString(), 500 );
		} else {
			var n = rows.length;
			res.setHeader( 'Content-Type', 'text/html; charset=UTF-8' );
			res.status( 200 );
			res.write( '<html><body>' );
			if (n === 0) {
				res.write('No titles returning 404!  All\'s well with the world!');
			} else {
				res.write('<h1> The following ' + n + ' titles return 404</h1>');
				res.write('<ul>');
				for (var i = 0; i < n; i++) {
					var prefix = rows[i].prefix, title = rows[i].title;
					var url = prefix + '.wikipedia.org/wiki/' + title;
					var name = prefix + ':' + title;
					res.write('<li><a href="http://' +
							  encodeURI(url).replace('&', '&amp;') + '">' +
							  name.replace('&', '&amp;') + '</a></li>\n');
				}
				res.write( '</ul>');
			}
			res.end('</body></html>' );
		}
	} );
};

var GET_failsDistr = function( req, res ) {
	db.query( dbFailsDistribution, [-1], function ( err, rows ) {
		if ( err ) {
			console.error( err );
			res.send( err.toString(), 500 );
		} else {
			var n = rows.length;
			res.setHeader( 'Content-Type', 'text/html; charset=UTF-8' );
			res.status( 200 );
			res.write( '<html><body>' );
			res.write('<h1> Distribution of semantic errors </h1>');
			res.write('<table><tbody>');
			res.write('<tr><th># errors</th><th># pages</th></tr>');
			for (var i = 0; i < n; i++) {
				var r = rows[i];
				res.write('<tr><td>' + r.fails + '</td><td>' + r.num_pages + '</td></tr>');
			}
			res.end('</table></body></html>' );
		}
	} );
};

var GET_skipsDistr = function( req, res ) {
	db.query( dbSkipsDistribution, [-1], function ( err, rows ) {
		if ( err ) {
			console.error( err );
			res.send( err.toString(), 500 );
		} else {
			var n = rows.length;
			res.setHeader( 'Content-Type', 'text/html; charset=UTF-8' );
			res.status( 200 );
			res.write( '<html><body>' );
			res.write('<h1> Distribution of syntactic errors </h1>');
			res.write('<table><tbody>');
			res.write('<tr><th># errors</th><th># pages</th></tr>');
			for (var i = 0; i < n; i++) {
				var r = rows[i];
				res.write('<tr><td>' + r.skips + '</td><td>' + r.num_pages + '</td></tr>');
			}
			res.end('</table></body></html>' );
		}
	} );
};

var makeCommitLink = function( commit, title, prefix ) {
	return '<a href="/result/' +
		commit + '/' + prefix + '/' + title +
		'">' + commit.substr( 0, 7 ) +
		'</a>';
};

var displayPageList = function(res, urlPrefix, page, header, err, rows) {
	console.log( 'GET ' + urlPrefix + "/" + page );
	if ( err ) {
		res.send( err.toString(), 500 );
	} else if ( !rows || rows.length <= 0 ) {
		res.send( 'No entries found', 404 );
	} else {
		res.setHeader( 'Content-Type', 'text/html; charset=UTF-8' );
		res.status( 200 );
		res.write('<html>');
		res.write('<head><style type="text/css">');
		res.write('th { padding: 0 10px }');
		res.write('td { text-align: center; }');
		res.write('td.title { text-align: left; }');
		res.write('</style></head>');
		res.write('<body>');

		if (header) {
			res.write("<b>" + header + "</b>");
		}

		res.write('<p>');
		if ( page > 0 ) {
			res.write( '<a href="' + urlPrefix + "/" + ( page - 1 ) + '">Previous</a> | ' );
		} else {
			res.write( 'Previous | ' );
		}
		if (rows.length === 40) {
			res.write('<a href="' + urlPrefix + "/" + ( page + 1 ) + '">Next</a>');
		}
		res.write('</p>');

		res.write('<table>');
		res.write('<tr><th>Title</th><th>New Commit</th><th>Errors|Fails|Skips</th><th>Old Commit</th><th>Errors|Fails|Skips</th></tr>' );

		for (var i = 0; i < rows.length; i++ ) {
			var r = rows[i];
			res.write('<tr>');
			res.write('<td class="title"><a href="http://parsoid.wmflabs.org/_rt/' +
					r.prefix + '/' + r.title.replace(/"/g, '&quot;') +
					'">' + r.prefix + ':' + r.title + '</a></td>');
			res.write('<td>' + makeCommitLink( r.new_commit, r.title, r.prefix ) + '</td>');
			res.write('<td>' + r.new_errors + "|" + r.new_fails + "|" + r.new_skips + '</td>');
			res.write('<td>' + makeCommitLink( r.old_commit, r.title, r.prefix ) + '</td>');
			res.write('<td>' + r.old_errors + "|" + r.old_fails + "|" + r.old_skips + '</td>');
			res.write('</tr>');
		}
		res.end( '</table></body></html>' );
	}
};

var GET_regressions = function( req, res ) {
	var page, offset, urlPrefix;
	if (req.params.length > 1) {
		var r1 = req.params[0];
		var r2 = req.params[1];
		urlPrefix = "/regressions/between/" + r1 + "/" + r2;
		page = (req.params[2] || 0) - 0;
		offset = page * 40;
		db.query( dbNumRegressionsBetweenRevs, [ r2, r1 ], function(err, row) {
			if (err || !row) {
				res.send( err.toString(), 500 );
			} else {
				var topfixesLink = "/topfixes/between/" + r1 + "/" + r2,
					header = "Total regressions between selected revisions: " +
							row[0].numRegressions +
							' | <a href="' + topfixesLink + '">topfixes</a>';
				db.query( dbRegressionsBetweenRevs, [ r2, r1, offset ],
					displayPageList.bind(null, res, urlPrefix, page, header));
			}
		});
	} else {
		urlPrefix = "/regressions";
		page = ( req.params[0] || 0 ) - 0;
		offset = page * 40;
		db.query( dbRegressedPages, [ offset ], displayPageList.bind(null, res, urlPrefix, page, null));
	}
};

var GET_topfixes = function( req, res ) {
	var page, offset, urlPrefix;
	if (req.params.length > 1) {
		var r1 = req.params[0];
		var r2 = req.params[1];
		urlPrefix = "/topfixes/between/" + r1 + "/" + r2;
		page = (req.params[2] || 0) - 0;
		offset = page * 40;
		db.query( dbNumFixesBetweenRevs, [ r2, r1 ], function(err, row) {
			if (err || !row) {
				res.send( err.toString(), 500 );
			} else {
				var regressionLink = "/regressions/between/" + r1 + "/" + r2,
					header = "Total fixes between selected revisions: " + row[0].numFixes +
						' | <a href="' + regressionLink + '">regressions</a>';
				db.query( dbFixesBetweenRevs, [ r2, r1, offset ],
					displayPageList.bind(null, res, urlPrefix, page, header));
			}
		});
	} else {
		urlPrefix = "/topfixes";
		page = ( req.params[0] || 0 ) - 0;
		offset = page * 40;
		db.query( dbFixedPages, [ offset ], displayPageList.bind(null, res, urlPrefix, page, null));
	}
};

var GET_commits = function( req, res ) {
	db.query( dbCommits, [-1], function ( err, rows ) {
		if ( err ) {
			console.error( err );
			res.send( err.toString(), 500 );
		} else {
			var n = rows.length;
			res.setHeader( 'Content-Type', 'text/html; charset=UTF-8' );
			res.status( 200 );
			res.write( '<html><body>' );
			res.write('<h1> List of all commits </h1>');
			res.write('<table><tbody>');
			res.write('<tr><th>Commit hash</th><th>Timestamp</th>' +
				  //'<th>Regressions</th><th>Fixes</th>' +
				  '<th>Tests</th>' +
				  '<th>-</th><th>+</th></tr>');
			for (var i = 0; i < n; i++) {
				var r = rows[i];
				res.write('<tr><td>' + r.hash + '</td><td>' + r.timestamp + '</td>');
				//res.write('<td>' + r.numregressions + '</td>');
				//res.write('<td>' + r.numfixes + '</td>');
				res.write('<td>' + r.numtests + '</td>');
				if ( i + 1 < n ) {
					res.write('<td><a href="/regressions/between/' + rows[i+1].hash +
						'/' + r.hash + '"><b>-</b></a></td>' );
					res.write('<td><a href="/topfixes/between/' + rows[i+1].hash +
						'/' + r.hash + '"><b>+</b></a></td>' );
				} else {
					res.write('<td></td><td></td>');
				}
				res.write('</tr>');
			}
			res.end('</table></body></html>' );
		}
	} );
};

// Make an app
var app = express.createServer();

// Make the coordinator app
var coordApp = express.createServer();

// Add in the bodyParser middleware (because it's pretty standard)
app.use( express.bodyParser() );
coordApp.use( express.bodyParser() );

// Main interface
app.get( /^\/results(\/([^\/]+))?$/, resultsWebInterface );

// Results for a title (on latest commit)
app.get( /^\/latestresult\/([^\/]+)\/(.*)$/, resultWebInterface );

// Results for a title on any commit
app.get( /^\/result\/([a-f0-9]*)\/([^\/]+)\/(.*)$/, resultWebInterface );

// List of failures sorted by severity
app.get( /^\/topfails\/(\d+)$/, failsWebInterface );
// 0th page
app.get( /^\/topfails$/, failsWebInterface );

// Overview of stats
app.get( /^\/$/, statsWebInterface );
app.get( /^\/stats(\/([^\/]+))?$/, statsWebInterface );

// Failed fetches
app.get( /^\/failedFetches$/, GET_failedFetches );

// Regressions -- 0th and later pages
app.get( /^\/regressions$/, GET_regressions );
app.get( /^\/regressions\/(\d+)$/, GET_regressions );
app.get( /^\/regressions\/between\/([^\/]+)\/([^\/]+)(?:\/(\d+))?$/, GET_regressions );

// Topfixes -- 0th and later pages
app.get( /^\/topfixes$/, GET_topfixes );
app.get( /^\/topfixes\/(\d+)$/, GET_topfixes );
app.get( /^\/topfixes\/between\/([^\/]+)\/([^\/]+)(?:\/(\d+))?$/, GET_topfixes );

// Distribution of fails
app.get( /^\/failsDistr$/, GET_failsDistr );

// Distribution of fails
app.get( /^\/skipsDistr$/, GET_skipsDistr );

// List of all commits
app.use( '/commits', GET_commits );

app.use( '/static', express.static( __dirname + '/static' ) );

// Clients will GET this path if they want to run a test
coordApp.get( /^\/title$/, getTitle );

// Receive results from clients
coordApp.post( /^\/result\/([^\/]+)\/([^\/]+)/, receiveResults );

// Start the app
app.listen( 8001 );
coordApp.listen( 8002 );

}() );
