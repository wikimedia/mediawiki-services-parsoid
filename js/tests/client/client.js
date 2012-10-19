/**
 * A client for testing round-tripping of articles.
 */

var http = require( 'http' ),
	qs = require( 'querystring' ),
	exec = require( 'child_process' ).exec,

	commit, ctime,
	lastCommit, lastCommitTime, lastCommitCheck,
	repoPath = __dirname,

	config = require( process.argv[2] || './config.js' ),
	rtTest = require( '../roundtrip-test.js' );

function getTitle( cb ) {
	var requestOptions = {
		host: config.server.host,
		port: config.server.port,
		path: '/title?commit=' + commit + '&ctime=' + encodeURIComponent( ctime ),
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
}

function runTest( cb, title ) {
	var result, callback = rtTest.cbCombinator.bind( null, rtTest.xmlFormat, function ( err, results ) {
		cb( title, results );
	} );

	try {
		rtTest.fetch( title, callback, config.interwiki );
	} catch ( err ) {
		// Log it to console (for gabriel to watch scroll by)
		console.error( "ERROR in " + title + ': ' + err );

		cb( title, rtTest.xmlFormat( title, err, null ) );
	}
}

function postResult( cb, title, result ) {
	getGitCommit( function ( newCommit, newTime ) {
		result = qs.stringify( { results: result, commit: newCommit, ctime: newTime } );

		var requestOptions = {
			host: config.server.host,
			port: config.server.port,
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'Content-Length': result.length
			},
			path: '/result/' + encodeURIComponent( title ),
			method: 'POST'
		},

		req = http.request( requestOptions, function ( res ) {
			res.on( 'end', function () {
				cb();
			} );
		} );

		req.write( result, 'utf8' );
		req.end();
	} );
}

/**
 * Get the current git commit hash.
 */
function getGitCommit( cb ) {
	var now = Date.now();

	if ( !lastCommitCheck || ( now - lastCommitCheck ) > ( 5 * 60 * 1000 ) ) {
		lastCommitCheck = now;
		exec( 'git log --max-count=1 --pretty=format:"%H %ci"', { cwd: repoPath }, function ( err, data ) {
			var cobj = data.match( /^([^ ]+) (.*)$/ );
			lastCommit = cobj[1];
			lastCommitTime = cobj[2];
			cb( cobj[1], cobj[2] );
		} );
	} else {
		cb( lastCommit, lastCommitTime );
	}
}

function callbackOmnibus() {
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
			getGitCommit( function ( latestCommit ) {
				if ( latestCommit !== commit ) {
					process.exit( 0 );
				}

				getTitle( callbackOmnibus );
			} );
			break;
	}
};

if ( typeof module === 'object' ) {
	module.exports.getTitle = getTitle;
	module.exports.runTest = runTest;
	module.exports.postResult = postResult;
}

if ( module && !module.parent ) {
	getGitCommit( function ( commitHash, commitTime ) {
		commit = commitHash;
		ctime = commitTime;
		callbackOmnibus();
	} );
}
