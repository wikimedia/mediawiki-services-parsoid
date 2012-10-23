/**
 * A client for testing round-tripping of articles.
 */

( function () {

var http = require( 'http' ),
	qs = require( 'querystring' ),

// git log --max-count=1 --pretty=format:"%H""
// git rev-parse HEAD

	config = require( process.argv[1] || './config.js' ),
	rtTest = require( '../roundtrip-test.js' ),

getTitle = function ( cb ) {
	var requestOptions = {
		host: config.server.host,
		port: config.server.port,
		path: '/title',
		method: 'GET'
	},

	callback = function ( res ) {
		var title = '';

		res.setEncoding( 'utf8' );
		res.on( 'data', function ( chunk ) {
			title += chunk;
		} );

		res.on( 'end', function () {
			switch ( res.statusCode ) {
				case 200:
					cb( title );
					break;
				case 404:
					console.log( 'The server doesn\'t have any work for us right now, waiting half a minute....' );
					setTimeout( function () { cb(); }, 30000 );
					break;
				default:
					console.log( 'There was some error probably, but that is fine. Waiting 15 seconds to resume....' );
					setTimeout( function () { cb(); }, 15000 );
			}
		} );
	};

	http.get( requestOptions, callback );
},

runTest = function ( cb, title ) {
	var result, callback = rtTest.cbCombinator.bind( null, rtTest.xmlFormat, function ( err, results ) {
		cb( title, results );
	} );

	try {
		rtTest.fetch( title, callback, config.interwiki );
	} catch ( err ) {
		// Log it to console (for gabriel to watch scroll by)
		console.log( err );

		cb( title, rtTest.xmlFormat( title, err, null ) );
	}
},

postResult = function ( cb, title, result ) {
	result = qs.stringify( { results: result } );

	var requestOptions = {
		host: config.server.host,
		port: config.server.port,
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			'Content-Length': result.length
		},
		path: '/result/' + encodeURIComponent( config.clientName ) + '/' + encodeURIComponent( title ),
		method: 'POST'
	},

	req = http.request( requestOptions, function ( res ) {
		res.on( 'end', function () {
			cb();
		} );
	} );

	req.write( result, 'utf8' );
	req.end();
},

callbackOmnibus = function () {
	switch ( arguments.length ) {
		case 1:
			console.log( 'Running a test on ' + arguments[0] +  '....' );
			runTest( callbackOmnibus, arguments[0] );
			break;
		case 2:
			console.log( 'Posting a result for ' + arguments[0] + '....' );
			postResult( callbackOmnibus, arguments[0], arguments[1] );
			break;
		default:
			getTitle( callbackOmnibus );
			break;
	}
};

if ( typeof module === 'object' ) {
	module.exports.getTitle = getTitle;
	module.exports.runTest = runTest;
	module.exports.postResult = postResult;
}

if ( module && !module.parent ) {
	callbackOmnibus();
}

}() );
