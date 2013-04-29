#!/usr/bin/env node

/**
 * Split up a bug report JSON file into a bunch of files
 */

var fs = require('fs'),
	Util = require( '../lib/mediawiki.Util.js' ).Util;

function writeFiles ( bugfileName, data ) {
	var keys = Object.keys(data),
		val, dirName;

	// SSS: the 'wiki' field adds the 'wiki' string at the end
	// which is unnecessary
	dirName = "./" + (data.wiki || 'none').replace(/wiki$/, '') + "." +
		(data.title || 'no-title') + "." +
		(data.timestamp || ('now-' + JSON.stringify(new Date())));

	// Create dir
	fs.mkdirSync(dirName, "0755");

	// Output files
	for ( var i = 0; i < keys.length; i++ ) {
		var key = keys[i],
			fileName = encodeURIComponent(key);
		console.log( 'Creating file ' + fileName );

		val = data[key];

		if (fileName === 'originalHtml') {
			// Strip everything upto <body> and after </body> tag
			val = val.replace(/^.*<body[^<>]*>|<\/body>.*$/g, '');
		}

		if (fileName === 'editedHtml') {
			// SSS NOTE: Right now, editedHtml comes with these
			// tags stripped out and this is a NOP which is why we are
			// stripped this from originalHtml.  However, by adding
			// the stripping on the edited HTML, we don't have to worry
			// about tweaking the code if VE changed what it emitted.
			//
			// Strip everything upto <body> and after </body> tag
			val = val.replace(/^.*<body[^<>]*>|<\/body>.*$/g, '');
			// Apply smart quoting to minimize diff
			val = Util.compressHTML(val);
		}

		fs.writeFileSync(dirName + "/" + fileName, val);
	}

	// Move bug report into the new dir so it doesn't clutter the base dir
	//fs.renameSync( bugfileName, dirName + "/" + bugfileName.replace(/^.*\//, ''));
}

function main () {
	if ( process.argv.length === 2 ) {
		console.warn( 'Split up a bug report into several files in the current directory');
		console.warn( 'Usage: ' + process.argv[0] + ' <bugreport.json>');
		process.exit(1);
	}

	var filename = process.argv[2],
		data;
	console.log( 'Reading ' + filename );
	try {
		data = JSON.parse(fs.readFileSync(filename));
	} catch ( e ) {
		console.error( 'Something went wrong while trying to read or parse ' + filename );
		console.error(e);
		process.exit(1);
	}
	writeFiles( filename, data );
}


main();
