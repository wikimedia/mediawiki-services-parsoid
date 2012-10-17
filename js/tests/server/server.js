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
		skipCount = result.match( /\<skipped/g ), failCount = result.match( /\<failure/g );

	skipCount = skipCount ? skipCount.length - 1 : 0;
	failCount = failCount ? failCount.length - 1 : 0;

	console.log( 'Client sent back results.' );

	res.setHeader( 'Content-Type', 'text/plain; charset=UTF-8' );

	console.log( 'Updating database' );
	db.run( 'UPDATE pages SET result = ?, skips = ?, fails = ?, client = ? WHERE title = ?',
		[ result, skipCount, failCount, clientName, title ], function ( err ) {
		console.log( 'Updated.' );
		if ( err ) {
			res.send( err.toString(), 500 );
		} else {
			console.log( title, '-', skipCount, 'skips,', failCount, 'fails' );
			res.send( '', 200 );
		}
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

// Clients will GET this path if they want to run a test
app.get( /^\/title$/, getTitle );

// Recieve results from clients
app.post( /^\/result\/([^\/]+)\/([^\/]+)/, recieveResults );

db.serialize( function () {
	db.run( 'CREATE TABLE IF NOT EXISTS pages ( title TEXT DEFAULT "", result TEXT DEFAULT NULL, claimed INTEGER DEFAULT NULL, client TEXT DEFAULT NULL , fails INTEGER DEFAULT NULL, skips INTEGER DEFAULT NULL );', function ( err )  {
		if ( err ) {
			console.log( dberr || err );
		} else {
			app.listen( 8001 );
		}
	} );
} );

}() );
