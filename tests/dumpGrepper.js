#!/usr/bin/env node
/**
 * A simple dump grepper based on the DumpReader module.
 */
"use strict";

var dumpReader = require('./dumpReader.js'),
	events = require('events'),
	util = require('util'),
	optimist = require('optimist'),
	Util = require( '../lib/mediawiki.Util.js' ).Util;

function DumpGrepper ( regexp ) {
	// inherit from EventEmitter
	events.EventEmitter.call(this);
	this.re = regexp;
}

util.inherits(DumpGrepper, events.EventEmitter);

DumpGrepper.prototype.grepRev = function ( revision, onlyFirst ) {
	var result = this.re.exec( revision.text ),
		matches = [];
	while ( result ) {
		matches.push( result );
		if ( onlyFirst ) { break; }
		result = this.re.exec( revision.text );
	}
	if ( matches.length ) {
		this.emit( 'match', revision, matches );
	}
};

module.exports.DumpGrepper = DumpGrepper;

if (module === require.main) {
	var argv = optimist.usage( 'Usage: zcat dump.xml.gz | $0 <regexp>', {
		'i': {
			description: 'Case-insensitive matching',
			'boolean': true,
			'default': false
		},
		'm': {
			description: 'Treat ^ and $ as matching beginning/end of *each* line, instead of beginning/end of entire article',
			'boolean': true,
			'default': false
		},
		'color': {
			description: 'Highlight matched substring using color. Use --no-color to disable.  Default is "auto".',
			'default': 'auto'
		},
		'l': {
			description: 'Suppress  normal  output;  instead  print the name of each article from which output would normally have been  printed.',
			'boolean': true,
			'default': false
		}
	} ).argv;

	if( argv.help ) {
		optimist.showHelp();
		process.exit( 0 );
	}
	Util.setColorFlags( argv );

	var flags = 'g';
	if( Util.booleanOption( argv.i ) ) {
		flags += 'i';
	}
	if( Util.booleanOption( argv.m ) ) {
		flags += 'm';
	}

	var re = new RegExp( argv._[0], flags );
	var onlyFirst = Util.booleanOption( argv.l );

	var reader = new dumpReader.DumpReader(),
		grepper = new DumpGrepper( re ),
		stats = {
			revisions: 0,
			matches: 0
		};

	reader.on( 'revision', function ( revision ) {
		stats.revisions++;
		grepper.grepRev( revision, onlyFirst );
	} );

	grepper.on( 'match', function ( revision, matches ) {
		stats.matches++;
		if ( Util.booleanOption( argv.l ) ) {
			console.log( revision.page.title );
			return;
		}
		for ( var i = 0, l = matches.length; i < l; i++ ) {
			console.log( '== Match: [[' + revision.page.title + ']] ==' );
			var m = matches[i];
			//console.warn( JSON.stringify( m.index, null, 2 ) );
			console.log(
					revision.text.substr( m.index - 40, 40 ) +
					m[0].green +
					revision.text.substr( m.index + m[0].length, 40 ) );
		}
	} );

	process.stdin.on ( 'end' , function() {
		// Print some stats
		console.warn( '################################################' );
		console.warn( 'Total revisions: ' + stats.revisions );
		console.warn( 'Total matches: ' + stats.matches );
		console.warn( 'Ratio: ' + (stats.matches / stats.revisions * 100) + '%' );
		console.warn( '################################################' );
	} );

	process.stdin.on('data', reader.push.bind(reader) );
	process.stdin.setEncoding('utf8');
	process.stdin.resume();


}

