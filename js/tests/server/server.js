#!/usr/bin/env node
( function () {
"use strict";

var express = require( 'express' ),
	optimist = require( 'optimist' );

// Default options
var defaults = {
	'host': 'localhost',
	'port': 3306,
	'database': 'parsoid',
	'user': 'parsoid',
	'password': 'parsoidpw',
	'debug': false,
	'fetches': 6,
	'tries': 6,
	'cutofftime': 600
};

// Settings file
var settings;
try {
	settings = require( './server.settings.js' );
} catch ( e ) {
	settings = {};
}

// Command line options
var argv = optimist.usage( 'Usage: $0 [connection parameters]' )
	.options( 'help', {
		'boolean': true,
		'default': false,
		describe: "Show usage information."
	} )
	.options( 'h', {
		alias: 'host',
		describe: 'Hostname of the database server.'
	} )
	.options( 'P', {
		alias: 'port',
		describe: 'Port number to use for connection.'
	} )
	.options( 'D', {
		alias: 'database',
		describe: 'Database to use.'
	} )
	.options( 'u', {
		alias: 'user',
		describe: 'User for MySQL login.'
	} )
	.options( 'p', {
		alias: 'password',
		describe: 'Password.'
	} )
	.options( 'd', {
		alias: 'debug',
		'boolean': true,
		describe: "Output MySQL debug data."
	} )
	.options( 'f', {
		alias: 'fetches',
		describe: "Number of times to try fetching a page."
	} )
	.options( 't', {
		alias: 'tries',
		describe: "Number of times an article will be sent for testing " +
			"before it's considered an error."
	} )
	.options( 'c', {
		alias: 'cutofftime',
		describe: "Time in seconds to wait for a test result."
	})
	.argv;

if ( argv.help ) {
	optimist.showHelp();
	process.exit( 0 );
}

var getOption = function( opt ) {
	var value;

	// Check possible options in this order: command line, settings file, defaults.
	if ( argv.hasOwnProperty( opt ) ) {
		value = argv[ opt ];
	} else if ( settings.hasOwnProperty( opt ) ) {
		value = settings[ opt ];
	} else if ( defaults.hasOwnProperty( opt ) ) {
		value = defaults[ opt ];
	} else {
		return undefined;
	}

	// Check the boolean options, 'false' and 'no' should be treated as false.
	// Copied from mediawiki.Util.js.
	if ( opt === 'debug' ) {
		if ( ( typeof value ) === 'string' &&
		     /^(no|false)$/i.test( value ) ) {
			return false;
		}
	}
	return value;
};

var // The maximum number of tries per article
	maxTries = getOption( 'tries' ),
	// The maximum number of fetch retries per article
	maxFetchRetries = getOption( 'fetches' ),
	// The time to wait before considering a test has failed
	cutOffTime = getOption( 'cutofftime' ),
	debug = getOption( 'debug' );

var mysql = require( 'mysql' );
var db = mysql.createConnection({
	host     : getOption( 'host' ),
	port     : getOption( 'port' ),
	database : getOption( 'database' ),
	user     : getOption( 'user' ),
	password : getOption( 'password'),
	multipleStatements : true,
	charset  : 'UTF8_BIN',
	debug    : debug
} );

var queues = require( 'mysql-queues' );
queues( db, debug );

// Try connecting to the database.
process.on( 'exit', function() {
	db.end();
} );
db.connect( function( err ) {
	if ( err ) {
		console.error( "Unable to connect to database, error: " + err.toString() );
		process.exit( 1 );
	}
} );

// ----------------- The queries --------------
var dbGetTitle =
	'SELECT id, title, prefix, claim_hash, claim_num_tries ' +
	'FROM pages ' +
	'WHERE num_fetch_errors < ? AND ' +
	'( claim_hash != ? OR ' +
		'( claim_num_tries <= ? AND claim_timestamp < ? ) ) ' +
	'ORDER BY claim_num_tries DESC, latest_score DESC, ' +
	'claim_timestamp ASC LIMIT ?,1';

var dbIncrementFetchErrorCount =
	'UPDATE pages SET num_fetch_errors = num_fetch_errors + 1 WHERE title = ? AND prefix = ?';

var dbInsertCommit =
	'INSERT IGNORE INTO commits ( hash, timestamp ) ' +
	'VALUES ( ?, ? )';

var dbFindPageByClaimHash =
	'SELECT id ' +
	'FROM pages ' +
	'WHERE title = ? AND prefix = ? AND claim_hash = ?';

var dbUpdatePageClaim =
	'UPDATE pages SET claim_hash = ?, claim_timestamp = ?, claim_num_tries = claim_num_tries + 1 ' +
	'WHERE id = ?';

var dbInsertResult =
	'INSERT INTO results ( page_id, commit_hash, result ) ' +
	'VALUES ( ?, ?, ? ) ' +
	'ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID( id ), ' +
		'result = VALUES( result )';

var dbInsertStats =
	'INSERT INTO stats ' +
	'( skips, fails, errors, score, page_id, commit_hash ) ' +
	'VALUES ( ?, ?, ?, ?, ?, ? ) ' +
	'ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID( id ), ' +
		'skips = VALUES( skips ), fails = VALUES( fails ), ' +
		'errors = VALUES( errors ), score = VALUES( score )';

var dbInsertPerfStatsStart =
	'INSERT INTO perfstats ' +
	'( page_id, commit_hash, type, value ) VALUES ';
var dbInsertPerfStatsEnd =
	' ON DUPLICATE KEY UPDATE value = VALUES( value )';

var dbUpdatePageLatestResults =
	'UPDATE pages ' +
	'SET latest_stat = ?, latest_score = ?, latest_result = ?, ' +
	'claim_timestamp = NULL, claim_num_tries = 0 ' +
    'WHERE id = ?';

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

var dbCommits =
	'SELECT hash, timestamp, ' +
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
var dbPerfStatsTypes =
	'SELECT DISTINCT type FROM perfstats';

var dbLastPerfStatsStart =
	'SELECT prefix, title, ';

var dbLastPerfStatsEnd =
	' FROM pages JOIN perfstats ON pages.id = perfstats.page_id ' +
	'WHERE perfstats.commit_hash = ' +
		'(SELECT hash FROM commits ORDER BY timestamp DESC LIMIT 1) ' +
	'GROUP BY pages.id ';

var dbPagePerfStatsStart =
	'SELECT commits.hash, commits.timestamp, ';

var dbPagePerfStatsEnd =
	' FROM (perfstats JOIN pages ON perfstats.page_id = pages.id) ' +
	'JOIN commits ON perfstats.commit_hash = commits.hash ' +
	'WHERE pages.prefix = ? AND pages.title = ? ' +
	'GROUP BY commits.hash ' +
	'ORDER BY commits.timestamp DESC ' +
	'LIMIT 0, ?';

var transUpdateCB = function( title, prefix, hash, type, res, trans, success_cb, err, result ) {
	if ( err ) {
		trans.rollback();
		var msg = "Error inserting/updating " + type + " for page: " +  prefix + ':' + title + " and hash: " + hash;
		console.error( msg );
		if ( res ) {
			res.send( msg, 500 );
		}
	} else if ( success_cb ) {
		success_cb( result );
	}
};

var claimPage = function( commitHash, cutOffTimestamp, req, res ) {
	var trans = db.startTransaction(),
		// reduce contention with a random offset
		randOffset = Math.floor(Math.random() * 20);

	trans.query( dbGetTitle,
			[ maxFetchRetries, commitHash, maxTries, cutOffTimestamp, randOffset ],
			function( err, rows ) {
		if ( err ) {
			trans.rollback( function() {
				console.error( 'Error getting next title: ' + err.toString() );
				res.send( "Error: " + err.toString(), 500 );
			} );
		} else if ( !rows || rows.length === 0 ) {
			// Couldn't find any page to test, just tell the client to wait.
			trans.rollback( function() {
				res.send( 'No available titles that fit the constraints.', 404 );
			} );
		} else {
			// Found a title to process.
			var page = rows[0];

			// Check if the selected title has arrived at the maximum number of
			// tries, which means we need to mark it as an error.
			if ( page.claim_hash && page.claim_num_tries === maxTries ) {
				// Too many failures, insert an error in stats and retry fetch.
				console.log( ' CRASHER?', page.prefix + ':' + page.title );
				var score = statsScore( 0, 0, 1 );
				var stats = [ 0, 0, 1, score, page.id, commitHash ];
				trans.query( dbInsertStats, stats,
					transUpdateCB.bind( null, page.title, page.prefix, commitHash, "stats", res, trans, function( insertedStat ) {
						trans.query( dbUpdatePageLatestResults, [ insertedStat.insertId, score, null, page.id ],
							transUpdateCB.bind( null, page.title, page.prefix, commitHash, "latest_result", res, trans, function() {
								trans.commit( function() {
									// After the error has been committed, go around
									// again to get a different title.
									claimPage( commitHash, cutOffTimestamp, req, res );
								} );
						} ) );
					} ) );
			} else {
				// No outstanding claim with too many tries, so update with this hash.
				trans.query( dbUpdatePageClaim, [ commitHash, new Date(), page.id ],
					transUpdateCB.bind( null, page.title, page.prefix, commitHash, "dbUpdatePageClaim", res, trans, function() {
						trans.commit( function() {
							console.log( ' ->', page.prefix + ':' + page.title, 'num_tries: ' + page.claim_num_tries.toString() );
							res.send( { prefix: page.prefix, title: page.title },  200);
						} );
					} ) );
			}
		}
	} ).execute();
};

var getTitle = function ( req, res ) {
	req.connection.setTimeout(300 * 1000);
	res.setHeader( 'Content-Type', 'text/plain; charset=UTF-8' );

	// Select pages that were not claimed in the 10 minutes.
	// If we didn't get a result from a client 10 minutes after
	// it got a rt claim on a page, something is wrong with the client
	// or with parsing the page.
	//
	// Hopefully, no page takes longer than 10 minutes to parse. :)

	claimPage( req.query.commit, new Date( Date.now() - ( cutOffTime * 1000 ) ), req, res );
};

var statsScore = function(skipCount, failCount, errorCount) {
	// treat <errors,fails,skips> as digits in a base 1000 system
	// and use the number as a score which can help sort in topfails.
	return errorCount*1000000+failCount*1000+skipCount;
};

var parsePerfStats = function( text ) {
	var regexp = /<perfstat[\s]+type="([\w\:]+)"[\s]*>([\d]+)/g;
	var perfstats = [];
	for ( var match = regexp.exec( text ); match !== null; match = regexp.exec( text ) ) {
		perfstats.push( { type: match[ 1 ], value: match[ 2 ] } );
	}
	return perfstats;
};

var insertPerfStats = function( db, pageId, commitHash, perfstats, cb ) {
	// If empty, just return
	if ( !perfstats || perfstats.length === 0 ) {
		if ( cb ) {
			return cb( null, null );
		}
		return;
	}
	// Build the query to insert all the results in one go:
	var dbStmt = dbInsertPerfStatsStart;
	for ( var i = 0; i < perfstats.length; i++ ) {
		if ( i !== 0 ) {
			dbStmt += ", ";
		}
		dbStmt += "( " + pageId.toString() + ", '" + commitHash + "', '" +
			perfstats[i].type + "', " + perfstats[i].value + ' )';
	}
	dbStmt += dbInsertPerfStatsEnd;

	// Make the query using the db arg, which could be a transaction
	db.query( dbStmt, null, cb );
};

var receiveResults = function ( req, res ) {
	req.connection.setTimeout(300 * 1000);
	var title = req.params[ 0 ],
		result = req.body.results,
		skipCount = result.match( /<skipped/g ),
		failCount = result.match( /<failure/g ),
		errorCount = result.match( /<error/g );
	var prefix = req.params[1];
	var commitHash = req.body.commit;
	var perfstats = parsePerfStats( result );

	skipCount = skipCount ? skipCount.length : 0;
	failCount = failCount ? failCount.length : 0;
	errorCount = errorCount ? errorCount.length : 0;

	res.setHeader( 'Content-Type', 'text/plain; charset=UTF-8' );

	// Keep record of the commit, ignore if already there.
	db.query( dbInsertCommit, [ commitHash, new Date() ], function ( err ) {
		if ( err ) {
			console.error( "Error inserting commit " + commitHash );
		}
	});

	var trans = db.startTransaction();
	//console.warn("got: " + JSON.stringify([title, commitHash, result, skipCount, failCount, errorCount]));
	if ( errorCount > 0 && result.match( 'DoesNotExist' ) ) {
		// Page fetch error, increment the fetch error count so, when it goes over
		/// maxFetchRetries, it won't be considered for tests again.
		console.log( 'XX', prefix + ':' + title );
		trans.query( dbIncrementFetchErrorCount, [title, prefix],
			transUpdateCB.bind( null, title, prefix, commitHash, "page fetch error count", res, trans, null ) )
			.commit( function( err ) {
				if ( err ) {
					console.error( "Error incrementing fetch count: " + err.toString() );
				}
				res.send( '', 200 );
			} );

	} else {
		trans.query( dbFindPageByClaimHash, [ title, prefix, commitHash ], function ( err, pages ) {
			if ( !err && pages && pages.length === 1 ) {
				// Found the correct page, fill the details up
				var page = pages[0];

				var score = statsScore( skipCount, failCount, errorCount );
				var latest_resultId = 0,
					latest_statId = 0;
				// Insert the result
				trans.query( dbInsertResult, [ page.id, commitHash, result ],
					transUpdateCB.bind( null, title, prefix, commitHash, "result", res, trans, function( insertedResult ) {
						latest_resultId = insertedResult.insertId;
						// Insert the stats
						trans.query( dbInsertStats, [ skipCount, failCount, errorCount, score, page.id, commitHash ],
							transUpdateCB.bind( null, title, prefix, commitHash, "stats", res, trans, function( insertedStat ) {
								latest_statId = insertedStat.insertId;

								// And now update the page with the latest info
								trans.query( dbUpdatePageLatestResults, [ latest_statId, score, latest_resultId, page.id ],
									transUpdateCB.bind( null, title, prefix, commitHash, "latest result", res, trans, function() {
										trans.commit( function() {
											console.log( '<- ', prefix + ':' + title, ':', skipCount, failCount,
												errorCount, commitHash.substr(0,7) );
											// Insert the performance stats, ignoring errors for now
											insertPerfStats( db, page.id, commitHash, perfstats, null );

											// Maybe the perfstats aren't committed yet, but it shouldn't be a problem
											res.send('', 200);
										} );
									} ) );
							} ) );
					} ) );
			} else {
				trans.rollback( function() {
					res.send( "Did not find claim for title: " + prefix + ':' + title, 500);
				} );
			}
		} ).execute();
	}
};

var indexLinkList = function () {
	return '<p>More details:</p>\n<ul>' +
		'<li><a href="/topfails">Results by title</a></li>\n' +
		'<li><a href="/failedFetches">Non-existing test pages</a></li>\n' +
		'<li><a href="/failsDistr">Histogram of failures</a></li>\n' +
		'<li><a href="/skipsDistr">Histogram of skips</a></li>\n' +
		'<li><a href="/commits">List of all tested commits</a></li>\n' +
		'<li><a href="/perfstats">Performance stats of last commit</a></li>\n' +
		'</ul>';
};

var displayPerfStat = function( type, value ) {
	// Protect against not-present perfstats, i.e. when adding new ones.
	if ( value === null ) {
		return '';
	}

	var text = '<span title="' + value.toString() + '">';
	if ( type.match( /^time/ ) ) {
		// Show time in seconds
		value = Math.round( (value / 1000) * 100 ) / 100;
		text += value.toString() + "s";
	} else if ( type.match( /^size/ ) ) {
		// Show sizes in KiB
		value = Math.round( value / 1024 );
		text += value.toString() + "KiB";
	} else {
		// Other values go as they are
		text += value.toString();
	}
	text += '</span>';
	return text;
};

var displayPageTitle = function( res, row ) {
	// If this info is available, we can display the small color bar at
	// the start of each row.
	var showColor = row.hasOwnProperty( 'skips' ) &&
		row.hasOwnProperty( 'fails' ) &&
		row.hasOwnProperty( 'errors' );

	res.write( '<td class="title"' );
	if ( showColor ) {
		res.write( ' style="border-left: 5px solid ' );
		if ( row.skips === 0 && row.fails === 0 && row.errors === 0 ) {
			res.write( 'green' );
		} else if ( row.errors > 0 || row.fails > 0 ) {
			res.write( 'red' );
		} else {
			res.write( 'orange' );
		}
		res.write( '">' );
	} else {
		res.write( '>' );
	}

	var prefix = encodeURIComponent( row.prefix ),
		title = encodeURIComponent( row.title );
	res.write( '<a href="http://parsoid.wmflabs.org/_rt/' +
		prefix + '/' + title + '">' +
		row.prefix + ':' + row.title + '</a> | ' +
		'<a target="_blank" href="http://localhost:8000/_rt/' + prefix + '/' + title +
		'">@lh</a> | ' +
		'<a target="_blank" href="/latestresult/' + prefix + '/' + title + '">latest result</a>' +
		' | <a href="/pageperfstats/' + prefix + '/' + title + '">perf</a>' +
		'</td>' );
};

var displayPageList = function( res, urlPrefix, urlSuffix, page, header, displayTableHeaders, displayRow, err, rows ) {
	console.log( "GET " + urlPrefix + "/" + page + urlSuffix );
	if ( err ) {
		res.send( err.toString(), 500 );
	} else if ( !rows || rows.length <= 0 ) {
		res.send( "No entries found", 404 );
	} else {
		res.setHeader( 'Content-Type', 'text/html; charset=UTF-8' );
		res.status( 200 );
		res.write( '<html>') ;
		res.write( '<head><style type="text/css">' );
		res.write( 'th { padding: 0 10px }' );
		res.write( 'td { text-align: center; }' );
		res.write( 'td.title { text-align: left; padding-left: 0.4em; }' );
		res.write( '</style></head>' );
		res.write( '<body>' );

		if (header) {
			res.write( "<b>" + header + "</b>" );
		}

		res.write( '<p>' );
		if ( page > 0 ) {
			res.write( '<a href="' + urlPrefix + "/" + ( page - 1 ) + urlSuffix + '">Previous</a> | ' );
		} else {
			res.write( 'Previous | ' );
		}
		if ( rows.length === 40 ) {
			res.write('<a href="' + urlPrefix + "/" + ( page + 1 ) + urlSuffix + '">Next</a>');
		}
		res.write( '</p>' );

		res.write( '<table><tr><th>Title</th>' );
		if ( typeof( displayTableHeaders ) === 'function' ) {
			displayTableHeaders( res );
		} else {
			res.write( displayTableHeaders );
		}
		res.write( '</tr>' );

		for ( var i = 0; i < rows.length; i++ ) {
			var row = rows[ i ];
			res.write( '<tr>' );
			displayPageTitle( res, row );
			if ( typeof( displayRow ) === 'function' ) {
				displayRow( res, row );
			} else {
				for ( var p in row ) {
					res.write( '<td>' + row[p] + '</td>' );
				}
			}
			res.write( '</tr>' );
		}

		res.end( '</table></body></html>' );
	}
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
		queryParams = [ prefix, prefix, prefix, prefix,
		                prefix, prefix, prefix, prefix ];
	} else {
		query = dbStatsQuery;
		queryParams = null;
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
			displayRow(res, "Regressions",
			           '<a href="/regressions/between/' + row[0].secondhash + '/' +
			           row[0].maxhash + '">' +
			           numRegressions + '</a>');
			displayRow(res, "Fixes",
			           '<a href="/topfixes/between/' + row[0].secondhash + '/' +
			           row[0].maxhash + '">' +
			           numFixes + '</a>');
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
	var page = ( req.params[0] || 0 ) - 0,
		offset = page * 40;

	var failsTableHeader = '<th>Commit</th><th>Syntactic diffs</th><th>Semantic diffs</th><th>Errors</th></tr>';
	var displayFailsRow = function( res, row ) {
		res.write( '<td>' + makeCommitLink( row.hash, row.title, row.prefix ) + '</td>' );
		res.write( '<td>' + row.skips + '</td><td>' + row.fails + '</td><td>' + ( row.errors === null ? 0 : row.errors ) + '</td></tr>' );
	};
	db.query( dbFailsQuery, [ offset ],
		displayPageList.bind( null, res, '/topfails', '', page, "Results by title", failsTableHeader,
			displayFailsRow ) );
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
	} else if ( row && row.length > 0 ) {
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
	db.query( dbFailsDistribution, null, function ( err, rows ) {
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
	db.query( dbSkipsDistribution, null, function ( err, rows ) {
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

var displayRegressionRow = function( res, r ) {
	res.write( '<td>' + makeCommitLink( r.new_commit, r.title, r.prefix ) + '</td>' );
	res.write( '<td>' + r.errors + "|" + r.fails + "|" + r.skips + '</td>' );
	res.write( '<td>' + makeCommitLink( r.old_commit, r.title, r.prefix ) + '</td>' );
	res.write( '<td>' + r.old_errors + "|" + r.old_fails + "|" + r.old_skips + '</td>' );
};

var regressionsHeader =
	'<th>New Commit</th><th>Errors|Fails|Skips</th><th>Old Commit</th><th>Errors|Fails|Skips</th>';

var GET_regressions = function( req, res ) {
	var page, offset, urlPrefix;
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
				displayPageList.bind( null, res, urlPrefix, '', page, header,
					regressionsHeader, displayRegressionRow ));
		}
	});
};

var GET_topfixes = function( req, res ) {
	var page, offset, urlPrefix;
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
				displayPageList.bind( null, res, urlPrefix, '', page, header,
					regressionsHeader, displayRegressionRow ));
		}
	});
};

var GET_commits = function( req, res ) {
	db.query( dbCommits, null, function ( err, rows ) {
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

var perfStatsTypes = function( cb ) {
	// As MySQL doesn't support PIVOT, we need to get all the perfstats types
	// first so we can get then as columns afterwards
	db.query( dbPerfStatsTypes, null, function( err, rows ) {
		if ( err ) {
			cb( err, null );
		} else if ( !rows || rows.length === 0 ) {
			cb( "No performance stats found", null );
		} else {
			var types = [];
			for ( var i = 0; i < rows.length; i++ ) {
				types.push( rows[i].type );
			}

			// Sort the profile types by name
			types.sort();

			cb( null, types );
		}
	} );
};

var GET_perfStats = function( req, res ) {
	var page = ( req.params[0] || 0 ) - 0,
		offset = page * 40,
		orderBy = 'prefix ASC, title ASC',
		urlSuffix = '';

	if ( req.query.orderby ) {
		orderBy = mysql.escapeId( req.query.orderby ) + ' DESC';
		urlSuffix = '?orderby=' + req.query.orderby;
	}

	perfStatsTypes( function( err, types ) {
		if ( err ) {
			res.send( err.toString(), 500 );
		} else {

			var displayPerfStatRow = function( res, r ) {
				for ( var j = 0; j < types.length; j++ ) {
					var type = types[ j ];
					res.write( '<td>' + displayPerfStat( type, r[ type ] ) + '</td>' );
				}
			};

			// Create the query to retrieve the stats per page
			var perfStatsHeader = '';
			var dbStmt = dbLastPerfStatsStart;
			for( var t = 0; t < types.length; t++ ) {
				if ( t !== 0 ) {
					dbStmt += ", ";
				}
				dbStmt += "SUM( IF( TYPE='" + types[ t ] +
					"', value, NULL ) ) AS '" + types[ t ] + "'";
				perfStatsHeader += '<th><a href="/perfstats?orderby=' +
					types[ t ] + '">' +
					types[ t ] + '</th>';
			}
			dbStmt += dbLastPerfStatsEnd;
			dbStmt += 'ORDER BY ' + orderBy;
			dbStmt += ' LIMIT 40 OFFSET ' + offset.toString();

			db.query( dbStmt, null,
				displayPageList.bind( null, res, "/perfstats", urlSuffix, page,
				"Performance stats", perfStatsHeader, displayPerfStatRow ) );
		}
	} );
};

var GET_pagePerfStats = function( req, res ) {
	if ( req.params.length < 2 ) {
		res.send( "No title given.", 500 );
	}

	var prefix = req.params[0],
		title = req.params[1];

	perfStatsTypes( function( err, types ) {
		if ( err ) {
			res.send( err.toString(), 500 );
		} else {
			var dbStmt = dbPagePerfStatsStart;
			for ( var t = 0; t < types.length; t++ ) {
				if ( t !== 0 ) {
					dbStmt += ", ";
				}

				dbStmt += "SUM( IF( type='" + types[t] +
					"', value, NULL ) ) AS '" + types[ t ] + "'";
			}
			dbStmt += dbPagePerfStatsEnd;

			// Get maximum the last 10 commits.
			db.query( dbStmt, [ prefix, title, 10 ], function( err, rows ) {
				if ( err ) {
					res.send( err.toString(), 500 );
				} else if ( !rows || rows.length === 0 ) {
					res.send( "No performance results found for page.", 404 );
				} else {
					res.status( 200 );
					res.write( '<html>') ;
					res.write( '<head><style type="text/css">' );
					res.write( 'th { padding: 0 10px }' );
					res.write( 'td { text-align: center; }' );
					res.write( 'td.title { text-align: left; padding-left: 0.4em; }' );
					res.write( '</style></head>' );
					res.write( '<body>' );
					res.write( '<b>Performance results for ' + prefix + ':' + title + '</b><p/>' );
					res.write( '<table><tr><th>Commit</th>' );
					for ( t = 0; t < types.length; t++ ) {
						res.write( '<th>' + types[t] + '</th>' );
					}
					res.write( '</tr>' );

					// Show the results in order of timestamp.
					for ( var r = rows.length - 1; r >= 0; r-- ) {
						var row = rows[r];
						res.write( '<tr><td class="title"><span title="' +
							row.timestamp.toString() + '">' +
							'<a href="/result/' + row.hash + '/' + prefix + '/' + title + '">' +
							row.hash + '</a>' + '</span></td>' );
						for ( t = 0; t < types.length; t++ ) {
							res.write( '<td>' + displayPerfStat( types[ t ], row[ types[ t ] ] ) + '</td>' );
						}
						res.write( '</tr>' );
					}

					res.end( '</table></body></html' );
				}
			} );
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

// Regressions between two revisions.
app.get( /^\/regressions\/between\/([^\/]+)\/([^\/]+)(?:\/(\d+))?$/, GET_regressions );

// Topfixes between two revisions.
app.get( /^\/topfixes\/between\/([^\/]+)\/([^\/]+)(?:\/(\d+))?$/, GET_topfixes );

// Distribution of fails
app.get( /^\/failsDistr$/, GET_failsDistr );

// Distribution of fails
app.get( /^\/skipsDistr$/, GET_skipsDistr );
// Performance stats
app.get( /^\/perfstats\/(\d+)$/, GET_perfStats );
app.get( /^\/perfstats$/, GET_perfStats );
app.get( /^\/pageperfstats\/([^\/]+)\/(.*)$/, GET_pagePerfStats );

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
