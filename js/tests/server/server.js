( function () {

var http = require( 'http' ),
	express = require( 'express' ),
	sqlite = require( 'sqlite3' ),
	dbStack = [], dbFlag = false,
	db = new sqlite.Database( 'pages.db' ),

getTitle = function ( req, res ) {
	console.log( 'Client asked for title.' );

	res.setHeader( 'Content-Type', 'text/plain; charset=UTF-8' );

	db.serialize( function () {
		db.get( 'SELECT title FROM pages WHERE result IS NULL AND claimed IS NULL LIMIT 1', function ( err, row ) {
			if ( err ) {
				console.log( err );
				res.send( 'Error! ' + err.toString(), 500 );
			} else if ( row ) {
				db.run( 'UPDATE pages SET claimed = ? WHERE title = ?', [ Date.now(), row.title ], function ( err ) {
					if ( err ) {
						console.log( err );
						res.send( 'Error! ' + err.toString(), 500 );
					} else {
						res.send( row.title );
					}
				} );
			} else {
				res.send( 'no available titles that fit those constraints', 404 );
			}
		} );
	} );
},

recieveResults = function ( req, res ) {
	var clientName = req.params[0], title = decodeURIComponent( req.params[1] ), result = req.body.results,
		skipCount = result.match( /\<skipped/g ), failCount = result.match( /\<failure/g ), errorCount = result.match( /\<error/g );

	skipCount = skipCount ? skipCount.length - 1 : 0;
	failCount = failCount ? failCount.length - 1 : 0;
	errorCount = errorCount ? 1 : 0;

	console.log( 'Client sent back results.' );

	res.setHeader( 'Content-Type', 'text/plain; charset=UTF-8' );

	console.log( 'Updating database' );
	db.run( 'UPDATE pages SET result = ?, skips = ?, fails = ?, errors = ?, client = ? WHERE title = ?',
		[ result, skipCount, failCount, errorCount, clientName, title ], function ( err ) {
		console.log( 'Updated.' );
		if ( err ) {
			res.send( err.toString(), 500 );
		} else {
			console.log( title, '-', skipCount, 'skips,', failCount, 'fails,', errorCount, 'errors.' );
			res.send( '', 200 );
		}
	} );
},

statsWebInterface = function ( req, res ) {
	db.serialize( function () {
		db.all( 'SELECT title, skips, fails, errors FROM pages WHERE result IS NOT NULL ORDER BY errors DESC, fails DESC, skips DESC', function ( err, rows ) {
			var i, row, output, matches, total = {};

			if ( err ) {
				res.send( err.toString(), 500 );
			} else if ( rows.length <= 0 ) {
				res.send( 'No entries found', 404 );
			} else {
				res.setHeader( 'Content-Type', 'text/html' );
				res.status( 200 );
				res.write( '<html><body><table>' );
				res.write( '<tr><th>Title</th><th>Syntactic diffs</th><th>Semantic diffs</th><th>Errors</th></tr>' );
				for ( i = 0; i < rows.length; i++ ) {
					res.write( '<tr style="background-color: ' );
					row = rows[i];

					if ( row.skips === 0 && row.fails === 0 && row.errors === 0 ) {
						res.write( 'green' );
					} else if ( row.errors > 0 ) {
						res.write( 'red' );
					} else if ( row.fails === 0 ) {
						res.write( 'yellow' );
					} else {
						res.write( 'red' );
					}

					res.write( '"><td>' + row.title + '</td>' );
					res.write( '<td>' + row.skips + '</td><td>' + row.fails + '</td><td>' + ( row.errors === null ? 0 : row.errors ) + '</td></tr>' );
				}
				res.end( '</table></body></html>' );
			}
		} );
	} );
},

resultsWebInterface = function ( req, res ) {
	var hasStarted = false;

	db.all( 'SELECT result FROM pages WHERE result IS NOT NULL', function ( err, rows ) {
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

// Add in the bodyParser middleware (because it's pretty standard)
app.use( express.bodyParser() );

// Main interface
app.get( /^\/results$/, resultsWebInterface );

// Overview of stats
app.get( /^\/stats$/, statsWebInterface );

// Clients will GET this path if they want to run a test
app.get( /^\/title$/, getTitle );

// Recieve results from clients
app.post( /^\/result\/([^\/]+)\/([^\/]+)/, recieveResults );

db.serialize( function () {
	db.run( 'CREATE TABLE IF NOT EXISTS pages ( title TEXT DEFAULT "", result TEXT DEFAULT NULL, claimed INTEGER DEFAULT NULL, client TEXT DEFAULT NULL , fails INTEGER DEFAULT NULL, skips INTEGER DEFAULT NULL, errors INTEGER DEFAULT NULL );', function ( err )  {
		if ( err ) {
			console.log( dberr || err );
		} else {
			app.listen( 8001 );
		}
	} );
} );

}() );
