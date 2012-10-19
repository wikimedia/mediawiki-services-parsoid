( function () {

var http = require( 'http' ),
	express = require( 'express' ),
	sqlite = require( 'sqlite3' ),
	dbStack = [], dbFlag = false,
	argv = require( 'optimist' ).argv,
	db = new sqlite.Database( argv._[0] || '/mnt/rtserver/pages.db' ),
	// The maximum number of tries per article
	maxTries = 6,
	// The maximum number of fetch retries per article
	maxFetchRetries = 6,
	// "Random" estimate of how many pending pages we have in the db
	pendingPagesEstimate = 500;

// ----------------- Prepared queries --------------
var dbGetTitle = db.prepare(
	'SELECT pages.id, pages.title ' +
	'FROM pages ' +
	'LEFT JOIN claims ON pages.id = claims.page_id AND claims.commit_hash = ? AND timestamp < ? ' +
	'WHERE num_fetch_errors < ? AND (claims.id IS NULL OR (claims.has_errorless_result = 0 AND claims.num_tries < ?))' +
	'LIMIT 1 OFFSET ? ' );

var dbGetTitleRandom = db.prepare(
	'SELECT pages.id, pages.title ' +
	'FROM pages ' +
	'LEFT JOIN claims ON pages.id = claims.page_id AND claims.commit_hash = ? AND timestamp < ? ' +
	'WHERE num_fetch_errors < ? AND (claims.id IS NULL OR (claims.has_errorless_result = 0 AND claims.num_tries < ?))' +
	'ORDER BY RANDOM() LIMIT 1 ' );

var dbIncrementFetchErrorCount = db.prepare(
	'UPDATE pages SET num_fetch_errors = num_fetch_errors + 1 WHERE title = ?');

var dbClearFetchErrorCount = db.prepare(
	'UPDATE pages SET num_fetch_errors = 0 WHERE title = ?');

var dbInsertCommit = db.prepare(
	'INSERT OR IGNORE INTO commits ( hash, timestamp ) ' +
	'VALUES ( ?, ? )' );

var dbFindClaimByPageId = db.prepare(
	'SELECT claims.id FROM claims ' +
	'WHERE claims.page_id = ? AND claims.commit_hash = ?');

var dbFindClaimByTitle = db.prepare(
	'SELECT claims.id, claims.num_tries, claims.page_id FROM claims ' +
	'JOIN pages ON pages.id = claims.page_id AND pages.title = ? ' +
	'WHERE claims.commit_hash = ?');

var dbInsertClaim = db.prepare(
	'INSERT INTO claims ( page_id, commit_hash, timestamp ) ' +
	'VALUES ( ?, ?, ? )');

var dbUpdateClaim = db.prepare(
	'UPDATE claims SET timestamp = ?, num_tries = num_tries + 1 WHERE id = ?');

var dbUpdateClaimResult = db.prepare(
	'UPDATE claims SET has_errorless_result = 1 WHERE id = ?');

var dbFindStatRow = db.prepare(
	'SELECT id FROM stats WHERE page_id = ? AND commit_hash = ?');

var dbInsertResult = db.prepare(
	'INSERT INTO results ( claim_id, result ) ' +
	'VALUES ( ?, ? )');

var dbUpdateResult = db.prepare(
	'UPDATE results SET result = ? WHERE claim_id = ?');

var dbInsertClaimStats = db.prepare(
	'INSERT INTO stats ' +
	'( skips, fails, errors, score, page_id, commit_hash ) ' +
	'VALUES ( ?, ?, ?, ?, ?, ? )' );

var dbUpdateClaimStats = db.prepare(
	'UPDATE STATS ' +
	'SET skips = ?, fails = ?, errors = ?, score = ? ' +
	'WHERE page_id = ? AND commit_hash = ?');

var dbLatestCommitHash = db.prepare(
	'SELECT hash FROM commits ORDER BY timestamp LIMIT 1');

var dbTruncateStatsIdsTbl = db.prepare('DELETE FROM tmp_ids');

var dbFillStatsIdsTbl = db.prepare(
	'INSERT INTO tmp_ids(id) SELECT MAX(id) FROM stats GROUP BY page_id');

var dbCountQuery = db.prepare(
	'SELECT COUNT(*) AS total FROM tmp_ids');

// IMPORTANT: node-sqlite3 library has a bug where it seems to cache
// invalid results when a prepared statement has no variables.
// Without this dummy variable as a workaround for the caching bug,
// stats query always fails after the first invocation.  So, if you
// do upgrade the library, please test before removing this workaround.
var dbStatsQuery = db.prepare(
	'SELECT ? AS caching_bug_workaround, ' +
	'(SELECT count(*) FROM stats ' +
	'				  JOIN tmp_ids ON stats.id = tmp_ids.id) AS total, ' +
	'(SELECT count(*) FROM stats ' +
	'				  JOIN tmp_ids ON stats.id = tmp_ids.id ' +
	'				  WHERE errors = 0) AS no_errors, ' +
	'(SELECT count(*) FROM stats ' +
	'				  JOIN tmp_ids ON stats.id = tmp_ids.id ' +
	'				  WHERE errors = 0 AND fails = 0) AS no_fails, ' +
	'(SELECT count(*) FROM stats ' +
	'				  JOIN tmp_ids ON stats.id = tmp_ids.id ' +
	'				  WHERE errors = 0 AND fails = 0 AND skips = 0) AS no_skips');

var dbFailsQuery = db.prepare(
	'SELECT pages.title, commits.hash, stats.errors, stats.fails, stats.skips ' +
	'FROM stats ' +
	'JOIN pages ON stats.page_id = pages.id ' +
	'JOIN commits ON stats.commit_hash = commits.hash ' +
	'ORDER BY commits.timestamp DESC, stats.score DESC ' +
	'LIMIT 40 OFFSET ?' );

function dbUpdateErrCB(title, hash, type, msg, err) {
	if (err) {
		console.error("Error inserting/updating " + type + " for page: " + title + " and hash: " + hash);
		if (msg) {
			console.error(msg);
		}
		console.error("ERR: " + err);
	}
}

function titleCallback( req, res, retry, commitHash, cutOffTimestamp, err, row ) {
	if ( err && !retry ) {
		res.send( 'Error! ' + err.toString(), 500 );
	} else if ( err === null && row ) {
		db.serialize( function () {
			// SSS FIXME: what about error checks?
			dbInsertCommit.run( [ commitHash, decodeURIComponent( req.query.ctime ) ] );
			dbFindClaimByPageId.get( [ row.id, commitHash ], function ( err, claim ) {
				if (claim) {
					// Ignoring possible duplicate processing
					// Increment the # of tries, update timestamp
					dbUpdateClaim.run([Date.now(), claim.id],
						dbUpdateErrCB.bind(null, row.title, commitHash, "claim", null));
					res.send( row.title );
				} else {
					// Claim doesn't exist
					dbInsertClaim.run( [ row.id, commitHash, Date.now() ], function(err) {
						if (!err) {
							res.send( row.title );
						} else {
							console.error(err);
							console.error("Multiple clients trying to access the same title: " + row.title);
							// In the rare scenario that some other client snatched the
							// title before us, get a new title (use the randomized ordering query)
							dbGetTitleRandom.get( [ commitHash, cutOffTimestamp, maxFetchRetries, maxTries ],
								titleCallback.bind( null, req, res, false, commitHash, cutOffTimestamp ) );
						}
					});
				}
			});
		});
	} else if ( retry ) {
		// Try again with the slow DB search method
		dbGetTitleRandom.get( [ commitHash, cutOffTimestamp, maxFetchRetries, maxTries ],
			titleCallback.bind( null, req, res, false, commitHash, cutOffTimestamp ) );
	} else {
		res.send( 'no available titles that fit those constraints', 404 );
	}
}

function fetchPage( commitHash, cutOffTimestamp, req, res ) {
	// This query picks a random page among the first 'pendingPagesEstimate' pages
	var rowOffset = Math.floor(Math.random() * pendingPagesEstimate);
	dbGetTitle.get([ commitHash, cutOffTimestamp, maxFetchRetries, maxTries, rowOffset ],
		titleCallback.bind( null, req, res, true, commitHash, cutOffTimestamp ) );
}

var getTitle = function ( req, res ) {
	res.setHeader( 'Content-Type', 'text/plain; charset=UTF-8' );

	// Select pages that were not claimed in the last hour
	fetchPage(req.query.commit, Date.now() - 3600, req, res);
},

receiveResults = function ( req, res ) {
	var title = decodeURIComponent( req.params[0] ),
		result = req.body.results,
		skipCount = result.match( /\<skipped/g ),
		failCount = result.match( /\<failure/g ),
		errorCount = result.match( /\<error/g );

	skipCount = skipCount ? skipCount.length - 1 : 0;
	failCount = failCount ? failCount.length - 1 : 0;
	errorCount = errorCount ? 1 : 0;

	res.setHeader( 'Content-Type', 'text/plain; charset=UTF-8' );

	var commitHash = req.body.commit;
	//console.warn("got: " + JSON.stringify([title, commitHash, result, skipCount, failCount, errorCount]));
	if ( errorCount > 0 && result.match( 'DoesNotExist' ) ) {
		console.log( 'XX', title );
		dbIncrementFetchErrorCount.run([title],
			dbUpdateErrCB.bind(null, title, commitHash, "page fetch error count", "null"));

		// NOTE: the last db update may not have completed yet
		// For now, always sending HTTP 200 back to client.
		res.send( '', 200 );
	} else {
		dbFindClaimByTitle.get( [ title, commitHash ], function ( err, claim ) {
			if (!err && claim) {
				db.serialize( function () {
					dbClearFetchErrorCount.run([title],
						dbUpdateErrCB.bind(null, title, commitHash, "page fetch error count", "null"));

					// treat <errors,fails,skips> as digits in a base 1000 system
					// and use the number as a score which can help sort in topfails.
					var score = errorCount*1000000+failCount*1000+skipCount;
					var stats = [skipCount, failCount, errorCount, score];

					// set 'has_errorless_result = 1' if we get a result without errors!
					if (errorCount === 0) {
						dbUpdateClaimResult.run([claim.id],
							dbUpdateErrCB.bind(null, title, commitHash, "claim result", "null"));
					}

					// Insert/update result and stats depending on whether this was
					// the first try or a subsequent retry -- prevents duplicates
					if (claim.num_tries === 1) {
						dbInsertResult.run([claim.id, result],
							dbUpdateErrCB.bind(null, title, commitHash, "result", "null"));
						dbInsertClaimStats.run(stats.concat([claim.page_id, commitHash]),
							dbUpdateErrCB.bind(null, title, commitHash, "stats", "null"));
					} else {
						dbUpdateResult.run([result, claim.id],
							dbUpdateErrCB.bind(null, title, commitHash, "result", "null"));
						dbUpdateClaimStats.run(stats.concat([claim.page_id, commitHash]),
							dbUpdateErrCB.bind(null, title, commitHash, "stats", "null"));
					}

					// NOTE: the last db update may not have completed yet
					// For now, always sending HTTP 200 back to client.
					res.send( '', 200 );
				});
			} else {
				var msg = "Did not find claim for title: " + title;
				msg = err ? msg + "\n" + err.toString() : msg;
				res.send(msg, 500);
			}
		} );
	}
},

statsWebInterface = function ( req, res ) {
	// Fetch stats for commit
	// 1. truncate tmp_ids table
	// 2. fill it up with max_id or every page
	// 3. fetch stats by using ids from the tmp_ids table.
	dbTruncateStatsIdsTbl.run([], function(err) {
		if (err) {
			console.error("tmp_ids truncate query returned err: " + JSON.stringify(err));
		}
		dbFillStatsIdsTbl.run([], function(err) {
			if (err) {
				console.error("tmp_ids fill query returned err: " + JSON.stringify(err));
			}
			dbStatsQuery.get([-1], function ( err, row ) {
				if ( err || !row ) {
					var msg = "Stats query returned nothing!";
					msg = err ? msg + "\n" + err.toString() : msg;
					console.error("Error: " + msg);
					res.send( msg, 500 );
				} else {
					res.setHeader( 'Content-Type', 'text/html' );
					res.status( 200 );
					res.write( '<html><body>' );

					var tests = row.total,
						errorLess = row.no_errors,
						skipLess = row.no_skips,
						noErrors = Math.floor( 100 * errorLess / tests ),
						perfects = Math.floor( 100 * skipLess / tests ),
						syntacticDiffs = Math.floor( 100 * ( 1 - skipLess / tests ) );

					res.write( '<p>We have run roundtrip-tests on <b>' +
							   tests +
							   '</b> articles, of which <ul><li><b>' +
							   noErrors +
							   '%</b> parsed without crashes, source ' +
							   'retrieval failures or timeouts, </li><li><b>' +
							   syntacticDiffs +
							   '%</b> round-tripped without semantic differences, and </li><li><b>' +
							   perfects +
							   '%</b> round-tripped with no character differences at all.</li></ul></p>' );

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

					res.write( '<p><a href="/topfails/0">See the individual results by title</a></p>' );

					res.end( '</body></html>' );
				}
			});
		});
	});
},

failsWebInterface = function ( req, res ) {
	console.log( 'GET /topfails/' + req.params[0] );
	var page = ( req.params[0] || 0 ) - 0,
		offset = page * 40;

	dbFailsQuery.all( [ offset ],
		function ( err, rows ) {
			var i, row, output, matches, total = {};

			if ( err ) {
				res.send( err.toString(), 500 );
			} else if ( rows.length <= 0 ) {
				res.send( 'No entries found', 404 );
			} else {
				res.setHeader( 'Content-Type', 'text/html' );
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

				res.write( '<table><tr><th>Title</th><th>Syntactic diffs</th><th>Semantic diffs</th><th>Errors</th></tr>' );

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

					res.write( '"><a target="_blank" href="http://parsoid.wmflabs.org/_rt/en/' +
						row.title + '">' +
						row.title + '</a> | ' +
						'<a target="_blank" href="http://localhost:8000/_rt/en/' + row.title +
						'">@lh</a>' +
						'</td>' );

					res.write( '<td>' + row.skips + '</td><td>' + row.fails + '</td><td>' + ( row.errors === null ? 0 : row.errors ) + '</td></tr>' );
				}
				res.end( '</table></body></html>' );
			}
		}
	);
},

resultsWebInterface = function ( req, res ) {
	var hasStarted = false;

	db.all( 'SELECT result FROM results', function ( err, rows ) {
		var i;
		if ( err ) {
			console.log( err );
			res.send( err.toString(), 500 );
		} else {
			if ( rows.length === 0 ) {
				res.send( '', 404 );
			} else {
				res.setHeader( 'Content-Type', 'text/xml; charset=UTF-8' );
				res.status( 200 );
				res.write( '<testsuite>' );

				for ( i = 0; i < rows.length; i++ ) {
					res.write( rows[i].result );
				}

				res.end( '</testsuite>' );
			}
		}
	} );
},


// Make an app
app = express.createServer();

// Make the coordinator app
coordApp = express.createServer();

// Add in the bodyParser middleware (because it's pretty standard)
app.use( express.bodyParser() );
coordApp.use( express.bodyParser() );

// Main interface
app.get( /^\/results$/, resultsWebInterface );

// List of failures sorted by severity
app.get( /^\/topfails\/(\d+)$/, failsWebInterface );
// 0th page
app.get( /^\/topfails$/, failsWebInterface );

// Overview of stats
app.get( /^\/stats$/, statsWebInterface );

// Clients will GET this path if they want to run a test
coordApp.get( /^\/title$/, getTitle );

// Receive results from clients
coordApp.post( /^\/result\/([^\/]+)/, receiveResults );

// Start the app
app.listen( 8001 );
coordApp.listen( 8002 );

}() );
