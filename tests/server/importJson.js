#!/usr/bin/env node
"use strict";
/**
 * A utility for reading in a JSON-y list of articles to the database.
 */

var optimist = require( 'optimist' );

// Default options
var defaults = {
	'host': 'localhost',
	'port': 3306,
	'database': 'parsoid',
	'user': 'parsoid',
	'password': 'parsoidpw'
};

// Settings file
var settings;
try {
	settings = require( './server.settings.js' );
} catch ( e ) {
	settings = {};
}

// Command line options
var argv = optimist.usage( 'Usage: ./importJson.js titles.example.json' )
	.options( 'help', {
			description: 'Show this message',
			'boolean': true,
			'default': false
	} )
	.options( 'prefix', {
			description: 'Which wiki prefix to use; e.g. "en" for English wikipedia, "es" for Spanish, "mw" for mediawiki.org',
			'boolean': false,
			'default': 'en'
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
		describe: 'User for login.'
	} )
	.options( 'p', {
		alias: 'password',
		describe: 'Password.'
	} )
	.demand( 1 )
	.argv;

if ( argv.help ) {
	optimist.showHelp();
	process.exit( 0 );
}

var getOption = function( opt ) {
	// Check possible options in this order: command line, settings file, defaults.
	if ( argv.hasOwnProperty( opt ) ) {
		return argv[ opt ];
	} else if ( settings.hasOwnProperty( opt ) ) {
		return settings[ opt ];
	} else if ( defaults.hasOwnProperty( opt ) ) {
		return defaults[ opt ];
	} else {
		return undefined;
	}
};

var mysql = require( 'mysql' );
var db = mysql.createConnection({
	host     : getOption( 'host' ),
	port     : getOption( 'port' ),
	database : getOption( 'database' ),
	user     : getOption( 'user' ),
	password : getOption( 'password' ),
	charset  : 'UTF8_BIN',
	multipleStatements : true
});

var waitingCount = 0.5;

var dbInsert = 'INSERT IGNORE INTO pages ( title, prefix ) VALUES ( ?, ? )';

var insertRecord = function( record, prefix ) {
	waitingCount++;
	db.query( dbInsert, [ record, prefix ], function ( err ) {
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

	db.query( 'START TRANSACTION;' );

	for ( i = 0; i < titles.length; i++ ) {
		insertRecord( titles[i], options.prefix || 'en' );
	}

	db.query( 'COMMIT;' );

	waitingCount -= 0.5;
	if ( waitingCount <= 0 ) {
		console.log( 'Done!' );
	}
};

db.connect( function ( err ) {
	var filepath;
	if ( err ) {
		console.error( err );
	} else {
		filepath = argv._[0];
		if ( !filepath.match( /^\// ) ) {
			filepath = './' + filepath;
		}
		loadJSON( filepath, argv );
		db.end();
	}
} );
