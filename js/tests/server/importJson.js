/**
 * A utility for reading in a JSON-y list of articles to the database.
 */

var sqlite = require( 'sqlite3' ),
	optimist = require( 'optimist' ),

	db = new sqlite.Database( 'pages.db' ),

	dbInsert = db.prepare( 'INSERT INTO pages ( title ) VALUES ( ? )' );

	waitingCount = 0.5;

function insertRecord( record ) {
	waitingCount++;
	dbInsert.run( [ record ], function ( err ) {
		if ( err ) {
			console.log( err );
		} else {
			waitingCount--;

			if ( waitingCount <= 0 ) {
				console.log( 'Done!' );
			}
		}
	} );
}

function loadJSON( json ) {
	var i, titles = require( json );

	db.run( 'BEGIN TRANSACTION' );

	for ( i = 0; i < titles.length; i++ ) {
		insertRecord( titles[i] );
	}

	db.run( 'COMMIT TRANSACTION' );

	waitingCount -= 0.5;
	if ( waitingCount <= 0 ) {
		console.log( 'Done!' );
	}
}

db.serialize( function ( err ) {
	var filepath;
	if ( err ) {
		console.log( err );
	} else {
		filepath = optimist.argv._[0];
		if ( !filepath.match( /^\// ) ) {
			filepath = './' + filepath;
		}
		loadJSON( filepath );
	}
} );
