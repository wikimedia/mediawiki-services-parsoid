/**
 * Split up a bug report JSON file into a bunch of files
 */

var fs = require('fs');

function writeFiles ( data ) {
	var keys = Object.keys(data);
	for ( var i = 0; i < keys.length; i++ ) {
		var key = keys[i],
			fileName = encodeURIComponent(data[key]);
		console.log( 'Creating file ' + fileName );
		fs.writeFileSync(key, fileName);
	}
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
	writeFiles( data );
}


main();
