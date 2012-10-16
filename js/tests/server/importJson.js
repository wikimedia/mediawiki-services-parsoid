/**
 * A utility for reading in a JSON-y list of articles to the database.
 */

( function () {

var sqlite = require( 'sqlite3' ),
	optimist = require( 'optimist' ),

	db = new sqlite.Database( 'pages.db' ),

	waitingCount = 0.5,

insertRecord = function ( record ) {
	waitingCount++;
	db.run( 'INSERT INTO pages ( title ) VALUES ( ? )', [ record ], function ( err ) {
		if ( err ) {
			console.log( err );
		} else {
			waitingCount--;

			if ( waitingCount <= 0 ) {
				console.log( 'Done!' );
			}
		}
	} );
},

loadJSON = function ( json ) {
	var i, titles = require( json );

	for ( i = 0; i < titles.length; i++ ) {
		insertRecord( titles[i] );
	}

	waitingCount -= 0.5;
	if ( waitingCount <= 0 ) {
		console.log( 'Done!' );
	}
};

db.serialize( function ( err ) {
	db.run( 'CREATE TABLE IF NOT EXISTS pages ( title TEXT DEFAULT "", result TEXT DEFAULT NULL, claimed INTEGER DEFAULT NULL, client TEXT DEFAULT NULL , fails INTEGER DEFAULT NULL, skips INTEGER DEFAULT NULL );', function ( dberr )  {
		if ( dberr || err ) {
			console.log( dberr || err );
		} else {
			loadJSON( './' + optimist.argv._[0] );
		}
	} );
} );

}() );
