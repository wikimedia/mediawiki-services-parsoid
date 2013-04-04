#!/usr/bin/env node
"use strict";
/**
 * A utility for reading in a JSON-y list of articles to the database.
 */

var sqlite = require( 'sqlite3' ),
	optimist = require( 'optimist' ),

	db = new sqlite.Database( 'pages.db' ),

	dbInsert = db.prepare( 'INSERT INTO pages ( title, prefix ) VALUES ( ?, ? )' ),

	waitingCount = 0.5;

var insertRecord = function( record, prefix ) {
	waitingCount++;
	dbInsert.run( [ record, prefix ], function ( err ) {
		if ( err ) {
			console.error( err );
		} else {
			waitingCount--;

			if ( waitingCount <= 0 ) {
				console.log( 'Done!' );
			}
		}
	} );
};

var loadJSON = function( json, options ) {
	var i, titles = require( json );

	db.run( 'BEGIN TRANSACTION' );

	for ( i = 0; i < titles.length; i++ ) {
		insertRecord( titles[i], options.prefix || 'en' );
	}

	db.run( 'COMMIT TRANSACTION' );

	waitingCount -= 0.5;
	if ( waitingCount <= 0 ) {
		console.log( 'Done!' );
	}
};

var opts = optimist.usage( 'Usage: ./importJson.js titles.example.json', {
		'help': {
			description: 'Show this message',
			'boolean': true,
			'default': false
		},
		'prefix': {
			description: 'Which wiki prefix to use; e.g. "en" for English wikipedia, "es" for Spanish, "mw" for mediawiki.org',
			'boolean': false,
			'default': 'en'
		}
}).argv;

db.serialize( function ( err ) {
	var filepath;
	if ( err ) {
		console.error( err );
	} else {
		filepath = opts._[0];
		if ( !filepath.match( /^\// ) ) {
			filepath = './' + filepath;
		}
		loadJSON( filepath, opts );
	}
} );
