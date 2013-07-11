#!/usr/bin/env node
"use strict";
/**
 * A utility for reading in a JSON-y list of articles to the database.
 */

var opts = require( 'optimist' )
	.usage( 'Usage: ./importJson.js titles.example.json' )
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
	.demand( 1 )
	.argv;

var mysql = require( 'mysql' );
var db = mysql.createConnection({
	host     : opts.host,
	port     : opts.port,
	database : opts.database,
	user     : opts.user,
	password : opts.password,
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
		filepath = opts._[0];
		if ( !filepath.match( /^\// ) ) {
			filepath = './' + filepath;
		}
		loadJSON( filepath, opts );
		db.end();
	}
} );
