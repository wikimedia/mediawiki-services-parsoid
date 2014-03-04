#!/usr/bin/env node
( function () {
"use strict";

var express = require( 'express' ),
	optimist = require( 'optimist' ),
	hbs = require( 'handlebars' );

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
	'cutofftime': 600,
	'batch': 50
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
	} )
	.options( 'b', {
		alias: 'batch',
		describe: "Number of titles to fetch from database in one batch."
	} )
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
	// The number of pages to fetch at once
	batchSize = getOption( 'batch' ),
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
	'AND s1.score < s2.score ) as numfixes, '  +
	// Get latest commit crashers
	'(SELECT count(*) ' +
		'FROM pages ' +
		'WHERE claim_hash = (SELECT hash FROM commits ORDER BY timestamp DESC LIMIT 1) ' +
			'AND claim_num_tries >= ? ' +
			'AND claim_timestamp < ?) AS crashers ' +

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
	'AND s1.score < s2.score ) as numfixes, ' +
	// Get latest commit crashers
	'(SELECT count(*) ' +
		'FROM pages WHERE prefix = ? ' +
			'AND claim_hash = (SELECT hash FROM commits ORDER BY timestamp DESC LIMIT 1) ' +
			'AND claim_num_tries >= ? ' +
			'AND claim_timestamp < ?) AS crashers ' +

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

var dbNumOneDiffRegressionsBetweenRevs =
	'SELECT count(*) AS numFlaggedRegressions ' +
	'FROM pages ' +
	'JOIN stats AS s1 ON s1.page_id = pages.id ' +
	'JOIN stats AS s2 ON s2.page_id = pages.id ' +
	'WHERE s1.commit_hash = ? AND s2.commit_hash = ? AND s1.score > s2.score ' +
		'AND s2.fails = 0 AND s2.skips = 0 ' +
		'AND s1.fails = ? AND s1.skips = ? ';

var dbOneDiffRegressionsBetweenRevs =
	'SELECT pages.title, pages.prefix, ' +
	's1.commit_hash AS new_commit, ' +
	's2.commit_hash AS old_commit ' +
	'FROM pages ' +
	'JOIN stats AS s1 ON s1.page_id = pages.id ' +
	'JOIN stats AS s2 ON s2.page_id = pages.id ' +
	'WHERE s1.commit_hash = ? AND s2.commit_hash = ? AND s1.score > s2.score ' +
		'AND s2.fails = 0 AND s2.skips = 0 ' +
		'AND s1.fails = ? AND s1.skips = ? ' +
	'ORDER BY s1.score - s2.score DESC ' +
	'LIMIT 40 OFFSET ?';

var dbNumNewFailsRegressionsBetweenRevs =
	'SELECT count(*) AS numFlaggedRegressions ' +
	'FROM pages ' +
	'JOIN stats AS s1 ON s1.page_id = pages.id ' +
	'JOIN stats AS s2 ON s2.page_id = pages.id ' +
	'WHERE s1.commit_hash = ? AND s2.commit_hash = ? AND s1.score > s2.score ' +
		'AND s2.fails = 0 AND s1.fails > 0 ' +
		// exclude cases introducing exactly one skip/fail to a perfect
		'AND (s1.skips > 0 OR s1.fails <> 1 OR s2.skips > 0)';

var dbNewFailsRegressionsBetweenRevs =
	'SELECT pages.title, pages.prefix, ' +
	's1.commit_hash AS new_commit, s1.errors AS errors, s1.fails AS fails, s1.skips AS skips, ' +
	's2.commit_hash AS old_commit, s2.errors AS old_errors, s2.fails AS old_fails, s2.skips AS old_skips ' +
	'FROM pages ' +
	'JOIN stats AS s1 ON s1.page_id = pages.id ' +
	'JOIN stats AS s2 ON s2.page_id = pages.id ' +
	'WHERE s1.commit_hash = ? AND s2.commit_hash = ? AND s1.score > s2.score ' +
		'AND s2.fails = 0 AND s1.fails > 0 ' +
		// exclude cases introducing exactly one skip/fail to a perfect
		'AND (s1.skips > 0 OR s1.fails <> 1 OR s2.skips > 0) ' +
	'ORDER BY s1.score - s2.score DESC ' +
	'LIMIT 40 OFFSET ?';

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

var transFetchCB = function( msg, trans, failCb, successCb, err, result ) {
	if ( err ) {
		trans.rollback( function () {
			if ( failCb ) {
				failCb ( msg? msg + err.toString() : err, result );
			}
		} );
	} else if ( successCb ) {
		successCb( result );
	}
};

var fetchPages = function( commitHash, cutOffTimestamp, cb ) {
	var trans = db.startTransaction();

	trans.query( dbGetTitle,
			[ maxFetchRetries, commitHash, maxTries, cutOffTimestamp, batchSize ],
			transFetchCB.bind( null, "Error getting next titles", trans, cb, function ( rows ) {

		if ( !rows || rows.length === 0 ) {
			trans.commit( cb.bind( null, null, rows ) );
		} else {
			// Process the rows: Weed out the crashers.
			var pages = [];
			var pageIds = [];
			for ( var i = 0; i < rows.length; i++ ) {
				var row = rows[i];
				pageIds.push( row.id );
				pages.push( { id: row.id, prefix: row.prefix, title: row.title } );
			}

			trans.query( dbUpdatePageClaims, [ commitHash, new Date(), pageIds ],
				transFetchCB.bind( null, "Error updating claims", trans, cb, function () {
					trans.commit( cb.bind( null, null, pages ));
				} ) );
		}
	} ) ).execute();
};

var fetchedPages = [];
var lastFetchedCommit = null;
var lastFetchedDate = new Date(0);
var knownCommits;

var getTitle = function ( req, res ) {
	var commitHash = req.query.commit;
	var commitDate = new Date( req.query.ctime );
	var knownCommit = knownCommits && knownCommits[ commitHash ];

	req.connection.setTimeout(300 * 1000);
	res.setHeader( 'Content-Type', 'text/plain; charset=UTF-8' );

	// Keep track of known commits so we can discard clients still on older
	// versions. If we don't know about the commit, then record it
	// Use a transaction to make sure we don't start fetching pages until
	// we've done this
	if ( !knownCommit ) {
		var trans = db.startTransaction();
		if ( !knownCommits ) {
			knownCommits = {};
			trans.query( dbCommitHashes, null, function ( err, resCommitHashes ) {
				if ( err ) {
					console.log( "Error fetching known commits", err );
				} else {
					resCommitHashes.forEach( function ( v ) {
						knownCommits[ v.hash ] = commitDate;
					} );
				}
				} );
		}

		// New commit, record it
		knownCommits[ commitHash ] = commitDate;
		trans.query( dbInsertCommit, [ commitHash, new Date() ], function ( err, commitInsertResult ) {
			if ( err ) {
				console.error( "Error inserting commit " + commitHash );
			} else if ( commitInsertResult.affectedRows > 0 ) {
				// If this is a new commit, we need to clear the number of times a
				// crasher page has been sent out so that each title gets retested
				trans.query( dbUpdateCrashersClearTries, [ commitHash, maxTries ] );
			}
		} );

		trans.commit();
	}
	if ( knownCommit && commitHash !== lastFetchedCommit ) {
		// It's an old commit, tell the client so it can restart.
		// HTTP status code 426 Update Required
		res.send( "Old commit", 426 );
		return;
	}

	var fetchCb = function ( err, pages ) {
		if ( err ) {
			res.send( "Error: " + err.toString(), 500 );
			return;
		}

		if ( pages ) {
			// Get the pages that aren't already fetched, to guard against the
			// case of clients not finishing the whole batch in the cutoff time
			var newPages = pages.filter( function( p ) {
				return fetchedPages.every( function ( f ) {
					return f.id !== p.id;
				} );
			} );
			// Append the new pages to the already fetched ones, in case there's
			// a parallel request.
			fetchedPages = fetchedPages.concat( newPages );
		}
		if ( fetchedPages.length === 0 ) {
			// Send 404 to indicate no pages available now, clients depend on
			// this.
			res.send( 'No available titles that fit the constraints.', 404 );
		} else {
			var page = fetchedPages.pop();

			console.log( ' ->', page.prefix + ':' + page.title );
			res.send( page, 200 );
		}
	};

	// Look if there's a title available in the already fetched ones.
	// Ensure that we load a batch when the commit has changed.
	if ( fetchedPages.length === 0 ||
	     commitHash !== lastFetchedCommit ||
	     ( lastFetchedDate.getTime() + ( cutOffTime * 1000 ) ) < Date.now() ) {
		// Select pages that were not claimed in the 10 minutes.
		// If we didn't get a result from a client 10 minutes after
		// it got a rt claim on a page, something is wrong with the client
		// or with parsing the page.
		//
		// Hopefully, no page takes longer than 10 minutes to parse. :)

		lastFetchedCommit = commitHash;
		lastFetchedDate = new Date();
		fetchPages( commitHash, new Date( Date.now() - ( cutOffTime * 1000 ) ), fetchCb );
	} else {
		fetchCb();
	}
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

	var trans = db.startTransaction();
	//console.warn("got: " + JSON.stringify([title, commitHash, result, skipCount, failCount, errorCount]));
	if ( errorCount > 0 && result.match( 'DoesNotExist' ) ) {
		// Page fetch error, increment the fetch error count so, when it goes over
		/// maxFetchRetries, it won't be considered for tests again.
		console.log( 'XX', prefix + ':' + title );
		trans.query( dbIncrementFetchErrorCount, [commitHash, title, prefix],
			transUpdateCB.bind( null, title, prefix, commitHash, "page fetch error count", res, trans, null ) )
			.commit( function( err ) {
				if ( err ) {
					console.error( "Error incrementing fetch count: " + err.toString() );
				}
				res.send( '', 200 );
			} );

	} else {
		trans.query( dbFindPage, [ title, prefix ], function ( err, pages ) {
			if ( !err && pages.length === 1 ) {
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
								trans.query( dbUpdatePageLatestResults, [ latest_statId, score, latest_resultId, commitHash, page.id ],
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
					if (err) {
						res.send(err.toString(), 500);
					} else {
						res.send( "Did not find claim for title: " + prefix + ':' + title, 200);
					}
				} );
			}
		} ).execute();
	}
};

// block helper to reference js files in page head.
// options.fn is a function taking the present context and returning a string
// (whatever is between {{#jsFiles}} and {{/jsFiles}} in a template).
// This string becomes the value of a 'javascripts' key added to the context, to be
// rendered as html where {{{javascripts}}} appears in layout.html.
hbs.registerHelper('jsFiles', function(options){
	if (!this.javascripts) {
		this.javascripts = {};
	}
	this.javascripts = options.fn(this);
	return null;
});

var pageListData = [
	{ url: '/topfails', title: 'Results by title' },
	{ url: '/failedFetches', title: 'Non-existing test pages' },
	{ url:  '/failsDistr', title: 'Histogram of failures' },
	{ url: '/skipsDistr', title: 'Histogram of skips' },
	{ url: '/commits', title: 'List of all tested commits' },
	{ url: '/perfstats', title: 'Performance stats of last commit' }
];

hbs.registerHelper('formatPerfStat', function (type, value) {
	if ( type.match( /^time/ ) ) {
		// Show time in seconds
		value = Math.round( (value / 1000) * 100 ) / 100;
		return value.toString() + "s";
	} else if ( type.match( /^size/ ) ) {
		// Show sizes in KiB
		value = Math.round( value / 1024 );
		return value.toString() + "KiB";
	} else {
		// Other values go as they are
		return value.toString();
	}
});

var pageStatus = function(row) {
	var hasStatus = row.hasOwnProperty( 'skips' ) &&
		row.hasOwnProperty( 'fails' ) &&
		row.hasOwnProperty( 'errors' );

	if (hasStatus) {
		if ( row.skips === 0 && row.fails === 0 && row.errors === 0 ) {
			return 'perfect';
		} else if ( row.errors > 0 || row.fails > 0 ) {
			return 'fail';
		} else {
			return 'skip';
		}
	}
	return null;
};

var pageTitleData = function(row){
	var prefix = encodeURIComponent( row.prefix ),
	title = encodeURIComponent( row.title );
	return {
		title: row.prefix + ':' + row.title,
		titleUrl: 'http://parsoid.wmflabs.org/_rt/' + prefix + '/' + title,
		lh: 'http://localhost:8000/_rt/' + prefix + '/' + title,
		latest: '/latestresult/' + prefix + '/' + title,
		perf: '/pageperfstats/' + prefix + '/' + title
	};
};

var displayPageList = function(res, data, makeRow, err, rows){
	console.log( "GET " + data.urlPrefix + "/" + data.page + data.urlSuffix );
	if ( err ) {
		res.send( err.toString(), 500 );
	} else {
		res.status( 200 );
		var tableData = data;
		if (rows.length === 0) {
			tableData.header = undefined;
		} else {
			var tableRows = [];
			for (var i = 0; i < rows.length; i++) {
				var row = rows[i];
				var tableRow = {status: pageStatus(row), tableData: makeRow(row)};
				tableRows.push(tableRow);
			}
			tableData.paginate = true;
			tableData.row = tableRows;
			tableData.prev = data.page > 0;
			tableData.next = rows.length === 40;
		}
		hbs.registerHelper('prevUrl', function (urlPrefix, urlSuffix, page) {
			return urlPrefix + "/" + ( page - 1 ) + urlSuffix;
		});
		hbs.registerHelper('nextUrl', function (urlPrefix, urlSuffix, page) {
			return urlPrefix + "/" + ( page + 1 ) + urlSuffix;
		});
		res.render('table.html', tableData);
	}
};

var statsWebInterface = function ( req, res ) {
	var query, queryParams;
	var cutoffDate = new Date( Date.now() - ( cutOffTime * 1000 ) );
	var prefix = req.params[1] || null;

	// Switch the query object based on the prefix
	if ( prefix !== null ) {
		query = dbPerWikiStatsQuery;
		queryParams = [ prefix, prefix, prefix, prefix,
						prefix, prefix, prefix, prefix,
						prefix, maxTries, cutoffDate ];
	} else {
		query = dbStatsQuery;
		queryParams = [ maxTries, cutoffDate ];
	}

	// Fetch stats for commit
	db.query( query, queryParams, function ( err, row ) {
		if ( err ) {
			res.send( err.toString(), 500 );
		} else {
			res.status( 200 );

			var tests = row[0].total,
			errorLess = row[0].no_errors,
			skipLess = row[0].no_skips,
			numRegressions = row[0].numregressions,
			numFixes = row[0].numfixes,
			noErrors = Math.round( 100 * 100 * errorLess / ( tests || 1 ) ) / 100,
			perfects = Math.round( 100* 100 * skipLess / ( tests || 1 ) ) / 100,
			syntacticDiffs = Math.round( 100 * 100 *
				( row[0].no_fails / ( tests || 1 ) ) ) / 100;

		var width = 800;

		var data = {
			prefix: prefix,
			results: {
				tests: tests,
				noErrors: noErrors,
				syntacticDiffs: syntacticDiffs,
				perfects: perfects
			},
			graphWidths: {
				perfect: width * perfects / 100 || 0,
				syntacticDiff: width * ( syntacticDiffs - perfects ) / 100 || 0,
				semanticDiff: width * ( 100 - syntacticDiffs ) / 100 || 0
			},
			latestRevision: [
				{ description: 'Git SHA1', value: row[0].maxhash },
				{ description: 'Test Results', value: row[0].maxresults },
				{ description: 'Crashers', value: row[0].crashers,
					url: '/crashers' },
				{ description: 'Fixes', value: numFixes,
					url: '/topfixes/between/' + row[0].secondhash + '/' + row[0].maxhash },
				{ description: 'Regressions', value: numRegressions,
					url: '/regressions/between/' + row[0].secondhash + '/' + row[0].maxhash }
			],
			flaggedReg: [
				{ description: 'one fail',
					info: 'one new semantic diff, previously perfect',
					url: 'onefailregressions/between/' + row[0].secondhash + '/' + row[0].maxhash },
				{ description: 'one skip',
					info: 'one new syntactic diff, previously perfect',
					url: 'oneskipregressions/between/' + row[0].secondhash + '/' + row[0].maxhash },
				{ description: 'other new fails',
					info: 'other cases with semantic diffs, previously only syntactic diffs',
					url: 'newfailsregressions/between/' + row[0].secondhash + '/' + row[0].maxhash }
			],
			averages: [
				{ description: 'Errors', value: row[0].avgerrors },
				{ description: 'Fails', value: row[0].avgfails },
				{ description: 'Skips', value: row[0].avgskips },
				{ description: 'Score', value: row[0].avgscore }
			],
			pages: pageListData
		};

		// round numeric data, but ignore others
		hbs.registerHelper('round', function (val) {
			if ( isNaN(val) ) {
				return val;
			} else {
				return Math.round( val * 100 ) / 100;
			}
		});

		res.render('index.html', data);
		}
	});
};

var failsWebInterface = function ( req, res ) {
	var page = ( req.params[0] || 0 ) - 0,
		offset = page * 40;

	var makeFailsRow = function(row) {
		return [
			pageTitleData(row),
			commitLinkData(row.hash, row.title, row.prefix),
			row.skips,
			row.fails,
			row.errors === null ? 0 : row.errors
		];
	};

	var data = {
		page: page,
		urlPrefix: '/topfails',
		urlSuffix: '',
		heading: 'Results by title',
		header: ['Title', 'Commit', 'Syntactic diffs', 'Semantic diffs', 'Errors']
	};
	db.query( dbFailsQuery, [ offset ],
		displayPageList.bind( null, res, data, makeFailsRow ) );
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
				res.setHeader( 'Content-Type', 'text/xml; charset=UTF-8' );
				res.status( 200 );
				res.write( '<?xml-stylesheet href="/static/result.css"?>\n' );
				res.write( '<testsuite>' );
				for ( i = 0; i < rows.length; i++ ) {
					res.write( rows[i].result );
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
		res.send( 'no results for that page at the requested revision', 200 );
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
			res.status( 200 );
			var n = rows.length;
			var pageData = [];
			for (var i = 0; i < n; i++) {
				var prefix = rows[i].prefix, title = rows[i].title;
				var name = prefix + ':' + title;
				pageData.push({
					url: prefix.replace( /wiki$/, '' ) + '.wikipedia.org/wiki/' + title,
					linkName: name.replace('&', '&amp;')
				});
			}
			var heading = n === 0 ? 'No titles returning 404!  All\'s well with the world!' :
				'The following ' + n + ' titles return 404';
			var data = {
				alt: n === 0,
				heading: heading,
				items: pageData
			};
			hbs.registerHelper('formatUrl', function (url) {
				return 'http://' + encodeURI(url).replace('&', '&amp;');
			});
			res.render('list.html', data);
		}
	} );
};

var GET_crashers = function( req, res ) {
	var cutoffDate = new Date( Date.now() - ( cutOffTime * 1000 ) );
	db.query( dbCrashers, [ maxTries, cutoffDate ], function ( err, rows ) {
		if ( err ) {
			console.error( err );
			res.send( err.toString(), 500 );
		} else {
			res.status( 200 );
			var n = rows.length;
			var pageData = [];
			for (var i = 0; i < n; i++) {
				var prefix = rows[i].prefix,
					title = rows[i].title;
				pageData.push({
					description: rows[i].claim_hash,
					url: prefix.replace( /wiki$/, '' ) + '.wikipedia.org/wiki/' + title,
					linkName: prefix + ':' + title
				});
			}
			var heading = n === 0 ? 'No titles crash the testers! All\'s well with the world!' :
				'The following ' + n + ' titles crash the testers at least ' +
				maxTries + ' times ';
			var data = {
				alt: n === 0,
				heading: heading,
				items: pageData
			};
			hbs.registerHelper('formatUrl', function (url) {
				return 'http://' + encodeURI(url).replace('&', '&amp;');
			});
			res.render('list.html', data);
		}
	} );
};

var GET_failsDistr = function( req, res ) {
	db.query( dbFailsDistribution, null, function ( err, rows ) {
		if ( err ) {
			console.error( err );
			res.send( err.toString(), 500 );
		} else {
			res.status( 200 );
			var n = rows.length;
			var intervalData = [];
			for (var i = 0; i < n; i++) {
				var r = rows[i];
				intervalData.push({errors: r.fails, pages: r.num_pages});
			}
			var data = {
				heading: 'Distribution of semantic errors',
				interval: intervalData
			};
			res.render('histogram.html', data);
		}
	} );
};

var GET_skipsDistr = function( req, res ) {
	db.query( dbSkipsDistribution, null, function ( err, rows ) {
		if ( err ) {
			console.error( err );
			res.send( err.toString(), 500 );
		} else {
			res.status( 200 );
			var n = rows.length;
			var intervalData = [];
			for (var i = 0; i < n; i++) {
				var r = rows[i];
				intervalData.push({errors: r.skips, pages: r.num_pages});
			}
			var data = {
				heading: 'Distribution of syntactic errors',
				interval: intervalData
			};
			res.render('histogram.html', data);
		}
	} );
};

var commitLinkData = function(commit, title, prefix) {
	return {
		url: '/result/' + commit + '/' + prefix + '/' + title,
		name: commit.substr( 0, 7 )
	};
};

var makeRegressionRow = function(row) {
	return [
		pageTitleData(row),
		commitLinkData(row.old_commit, row.title, row.prefix),
		row.old_errors + "|" + row.old_fails + "|" + row.old_skips,
		commitLinkData(row.new_commit, row.title, row.prefix),
		row.errors + "|" + row.fails + "|" + row.skips
	];
};

var makeOneDiffRegressionRow = function(row) {
	return [
		pageTitleData(row),
		commitLinkData(row.old_commit, row.title, row.prefix),
		commitLinkData(row.new_commit, row.title, row.prefix)
	];
};

var regressionsHeaderData = ['Title', 'Old Commit', 'Errors|Fails|Skips', 'New Commit', 'Errors|Fails|Skips'];

var GET_regressions = function( req, res ) {
	var r1 = req.params[0];
	var r2 = req.params[1];
	var page = (req.params[2] || 0) - 0;
	var offset = page * 40;
	db.query( dbNumRegressionsBetweenRevs, [ r2, r1 ], function(err, row) {
		if (err) {
			res.send( err.toString(), 500 );
		} else {
			var data = {
				page: page,
				urlPrefix: '/regressions/between/' + r1 + '/' + r2,
				urlSuffix: '',
				heading: "Total regressions between selected revisions: " +
					row[0].numRegressions,
				headingLink: [{url: '/topfixes/between/' + r1 + '/' + r2, name: 'topfixes'}],
				header: regressionsHeaderData
			};
			db.query( dbRegressionsBetweenRevs, [ r2, r1, offset ],
				displayPageList.bind( null, res, data, makeRegressionRow ));
		}
	});
};

var GET_newFailsRegressions = function(req, res) {
	var r1 = req.params[0];
	var r2 = req.params[1];
	var page = (req.params[2] || 0) - 0;
	var offset = page * 40;
	db.query(dbNumNewFailsRegressionsBetweenRevs, [r2, r1], function(err, row) {
		if (err) {
			res.send(err.toString(), 500);
		} else {
			var data = {
				page: page,
				urlPrefix: '/regressions/between/' + r1 + '/' + r2,
				urlSuffix: '',
				heading: 'Flagged regressions between selected revisions: ' +
					row[0].numFlaggedRegressions,
				subheading: 'Old Commit: only syntactic diffs | New Commit: semantic diffs',
				headingLink: [
					{name: 'one fail regressions',
						info: 'one new semantic diff, previously perfect',
						url: '/onefailregressions/between/' + r1 + '/' + r2},
					{name: 'one skip regressions',
						info: 'one new syntactic diff, previously perfect',
						url: '/oneskipregressions/between/' + r1 + '/' + r2}
				],
				header: regressionsHeaderData
			};
			db.query(dbNewFailsRegressionsBetweenRevs, [r2, r1, offset],
				displayPageList.bind(null, res, data, makeRegressionRow));
		}
	});
};

var displayOneDiffRegressions = function(numFails, numSkips, subheading, headingLinkData, req, res){
	var r1 = req.params[0];
	var r2 = req.params[1];
	var page = (req.params[2] || 0) - 0;
	var offset = page * 40;
	db.query (dbNumOneDiffRegressionsBetweenRevs, [r2, r1, numFails, numSkips], function(err, row) {
		if (err) {
			res.send(err.toString(), 500);
		} else {
			var headingLink = [
				{name: headingLinkData[0],
					info: headingLinkData[1],
					url: '/' + headingLinkData[2] + 'regressions/between/' + r1 + '/' + r2},
				{name: 'other new fails',
					info: 'other cases with semantic diffs, previously only syntactic diffs',
					url: '/newfailsregressions/between/' + r1 + '/' + r2}
			];
			var data = {
				page: page,
				urlPrefix: '/regressions/between/' + r1 + '/' + r2,
				urlSuffix: '',
				heading: 'Flagged regressions between selected revisions: ' +
					row[0].numFlaggedRegressions,
				subheading: subheading,
				headingLink: headingLink,
				header: ['Title', 'Old Commit', 'New Commit']
			};
			db.query(dbOneDiffRegressionsBetweenRevs, [r2, r1, numFails, numSkips, offset],
				displayPageList.bind(null, res, data, makeOneDiffRegressionRow));
		}
	});
};

var GET_oneFailRegressions = displayOneDiffRegressions.bind(
	null, 1, 0, 'Old Commit: perfect | New Commit: one semantic diff',
	['one skip regressions', 'one new syntactic diff, previously perfect', 'oneskip']
);

var GET_oneSkipRegressions = displayOneDiffRegressions.bind(
	null, 0, 1, 'Old Commit: perfect | New Commit: one syntactic diff',
	['one fail regressions', 'one new semantic diff, previously perfect', 'onefail']
);

var GET_topfixes = function( req, res ) {
	var r1 = req.params[0];
	var r2 = req.params[1];
	var page = (req.params[2] || 0) - 0;
	var offset = page * 40;
	db.query( dbNumFixesBetweenRevs, [ r2, r1 ], function(err, row) {
		if (err) {
			res.send( err.toString(), 500 );
		} else {
			var data = {
				page: page,
				urlPrefix: '/topfixes/between/' + r1 + '/' + r2,
				urlSuffix: '',
				heading: 'Total fixes between selected revisions: ' + row[0].numFixes,
				headingLink: [{url: "/regressions/between/" + r1 + "/" + r2, name: 'regressions'}],
				header: regressionsHeaderData
			};
			db.query( dbFixesBetweenRevs, [ r2, r1, offset ],
				displayPageList.bind( null, res, data, makeRegressionRow ));
		}
	});
};

var GET_commits = function( req, res ) {
	db.query( dbCommits, null, function ( err, rows ) {
		if ( err ) {
			console.error( err );
			res.send( err.toString(), 500 );
		} else {
			res.status( 200 );
			var n = rows.length;
			var tableRows = [];
			for (var i = 0; i < n; i++) {
				var row = rows[i];
				var tableRow = {hash: row.hash, timestamp: row.timestamp, numtests: row.numtests};
				if ( i + 1 < n ) {
					tableRow.regUrl = '/regressions/between/' + rows[i+1].hash + '/' + row.hash;
					tableRow.fixUrl = '/topfixes/between/' + rows[i+1].hash + '/' + row.hash;
				}
				tableRows.push(tableRow);
			}
			var data = {
				latest: rows[n-1].timestamp.toString().slice(4,15),
				header: ['Commit hash', 'Timestamp', 'Tests', '-', '+'],
				row: tableRows
			};

			hbs.registerHelper('formatHash', function(hash){
				return hash.slice(0,10);
			});
			hbs.registerHelper('formatDate', function(timestamp){
				return timestamp.toString().slice(4,21);
			});
			hbs.registerHelper('formatNumber', function(n){
				var string = n.toString();
				return string.replace(/\B(?=(...)+(?!.))/g, ",");
			});

			res.render('commits.html', data);
		}
	} );
};

var cachedPerfStatsTypes;

var perfStatsTypes = function( cb ) {

	if (cachedPerfStatsTypes) {
		return cb(null, cachedPerfStatsTypes);
	}
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
			cachedPerfStatsTypes = types;

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

			var makePerfStatRow = function(row) {
				var result = [pageTitleData(row)];
				for (var j = 0; j < types.length; j++) {
					var type = types[j];
					var rowData = row[type] === null ? '' :
						{type: type, value: row[type], info: row[type]};
					result.push(rowData);
				}
				return result;
			};

			// Create the query to retrieve the stats per page
			var perfStatsHeader = ['Title'];
			var dbStmt = dbLastPerfStatsStart;
			for( var t = 0; t < types.length; t++ ) {
				if ( t !== 0 ) {
					dbStmt += ", ";
				}
				dbStmt += "SUM( IF( TYPE='" + types[ t ] +
					"', value, NULL ) ) AS '" + types[ t ] + "'";
				perfStatsHeader.push({
					url: '/perfstats?orderby=' + types[t],
					name: types[t]
				});
			}
			dbStmt += dbLastPerfStatsEnd;
			dbStmt += 'ORDER BY ' + orderBy;
			dbStmt += ' LIMIT 40 OFFSET ' + offset.toString();

			var data = {
				page: page,
				urlPrefix: '/perfstats',
				urlSuffix: urlSuffix,
				heading: 'Performance stats',
				header: perfStatsHeader
			};

			db.query( dbStmt, null,
				displayPageList.bind( null, res, data, makePerfStatRow ) );
		}
	} );
};

var GET_pagePerfStats = function( req, res ) {
	if ( req.params.length < 2 ) {
		res.send( "No title given.", 404 );
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
					res.send( "No performance results found for page.", 200 );
				} else {
					res.status( 200 );
					var tableHeaders = ['Commit'];
					for ( t = 0; t < types.length; t++ ) {
						tableHeaders.push(types[t]);
					}

					// Show the results in order of timestamp.
					var tableRows = [];
					for ( var r = rows.length - 1; r >= 0; r-- ) {
						var row = rows[r];
						var tableRow = [{
							url: '/result/' + row.hash + '/' + prefix + '/' + title,
							name: row.hash,
							info: row.timestamp.toString()
						}];
						for ( t = 0; t < types.length; t++ ) {
							var rowData = row[types[t]] === null ? '' :
								{type: types[t], value: row[types[t]], info: row[types[t]]};
							tableRow.push(rowData);
						}
						tableRows.push({tableData: tableRow});
					}

					var data = {
						heading: 'Performance results for ' + prefix + ':' + title,
						header: tableHeaders,
						row: tableRows
					};
					res.render('table.html', data);
				}
			} );
		}
	} );
};

// Make an app
var app = express.createServer();

// Configure for Handlebars
app.configure(function(){
	app.set('view engine', 'handlebars');
	app.register('.html', require('handlebars'));
});

// Declare static directory
app.use("/static", express.static(__dirname + "/static"));

// Make the coordinator app
var coordApp = express.createServer();

// Add in the bodyParser middleware (because it's pretty standard)
app.use( express.bodyParser() );
coordApp.use( express.bodyParser() );

// robots.txt: no indexing.
app.get(/^\/robots.txt$/, function ( req, res ) {
	res.end( "User-agent: *\nDisallow: /\n" );
});

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

// Crashers
app.get( /^\/crashers$/, GET_crashers );

// Regressions between two revisions.
app.get( /^\/regressions\/between\/([^\/]+)\/([^\/]+)(?:\/(\d+))?$/, GET_regressions );

// Regressions between two revisions that introduce one semantic error to a perfect page.
app.get(/^\/onefailregressions\/between\/([^\/]+)\/([^\/]+)(?:\/(\d+))?$/, GET_oneFailRegressions );

// Regressions between two revisions that introduce one syntactic error to a perfect page.
app.get(/^\/oneskipregressions\/between\/([^\/]+)\/([^\/]+)(?:\/(\d+))?$/, GET_oneSkipRegressions );

// Regressions between two revisions that introduce senantic errors (previously only syntactic diffs).
app.get(/^\/newfailsregressions\/between\/([^\/]+)\/([^\/]+)(?:\/(\d+))?$/, GET_newFailsRegressions );

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
app.get( '/commits', GET_commits );

// Clients will GET this path if they want to run a test
coordApp.get( /^\/title$/, getTitle );

// Receive results from clients
coordApp.post( /^\/result\/([^\/]+)\/([^\/]+)/, receiveResults );

// Start the app
app.listen( 8001 );
coordApp.listen( 8002 );

}() );
