#!/usr/bin/env node
"use strict";
/**
 * A client for testing round-tripping of articles.
 */

var http = require( 'http' ),
	request = require('request'),
	cluster = require('cluster'),
	qs = require( 'querystring' ),
	exec = require( 'child_process' ).exec,
	apiServer = require( '../apiServer.js' ),
	Util = require('../../lib/mediawiki.Util.js').Util,

	commit, ctime,
	lastCommit, lastCommitTime, lastCommitCheck,
	repoPath = __dirname,

	config = require( process.argv[2] || './config.js' ),
	parsoidURL = config.parsoidURL,
	rtTest = require( '../roundtrip-test.js' );


var getTitle = function( cb ) {
	var requestOptions = {
		uri: 'http://' + config.server.host + ':' +
			config.server.port + '/title?commit=' + commit + '&ctime=' + encodeURIComponent( ctime ),
		method: 'GET'
	},
	retries = 10;

	var callback = function ( error, response, body ) {
		if (error || !response) {
			setTimeout( function () { cb( 'start' ); }, 15000 );
			return;
		}

		var resp;
		switch ( response.statusCode ) {
			case 200:
				resp = JSON.parse( body );
				cb( 'runTest', resp.prefix, resp.title );
				break;
			case 404:
				console.log( 'The server doesn\'t have any work for us right now, waiting half a minute....' );
				setTimeout( function () { cb( 'start' ); }, 30000 );
				break;
			case 426:
				console.log( "Update required, exiting." );
				// Signal our voluntary suicide to the parent if running as a
				// cluster worker, so that it does not restart this client.
				// Without this, the code is never actually updated as a newly
				// forked client will still run the old code.
				if (cluster.worker) {
					cluster.worker.kill();
				} else {
					process.exit( 0 );
				}
				break;
			default:
				console.log( 'There was some error (' + response.statusCode + '), but that is fine. Waiting 15 seconds to resume....' );
				setTimeout( function () { cb( 'start' ); }, 15000 );
		}
	};

	Util.retryingHTTPRequest(10, requestOptions, callback );
};

var runTest = function( cb, prefix, title ) {
	var results, callback = rtTest.cbCombinator.bind( null, rtTest.xmlFormat, function ( err, results ) {
		if ( err ) {
			console.log( 'ERROR in ' + prefix + ':' + title + ':\n' + err + '\n' + err.stack);
			/*
			 * If you're looking at the line below and thinking "Why in the
			 * hell would they have done that, it causes unnecessary problems
			 * with the clients crashing", you're absolutely right. This is
			 * here because we use a supervisor instance to run our test
			 * clients, and we rely on it to restart dead'ns.
			 *
			 * In sum, easier to die than to worry about having to reset any
			 * broken application state.
			 */
			cb( 'postResult', err, results, prefix, title, function () { process.exit( 1 ); } );
		} else {
			cb( 'postResult', err, results, prefix, title, null );
		}
	} );

	try {
		rtTest.fetch( title, callback, {
			setup: config.setup,
			prefix: prefix,
			editMode: false,
			parsoidURL: parsoidURL
		} );
	} catch ( err ) {
		// Log it to console (for gabriel to watch scroll by)
		console.error( "ERROR in " + prefix + ':' + title + ': ' + err );

		results = rtTest.xmlFormat( {
			page: { name: title },
			wiki: { iwp: prefix }
		}, err );
		cb( 'postResult', err, results, prefix, title, function() { process.exit( 1 ); } );
	}
};

/**
 * Get the current git commit hash.
 */
var getGitCommit = function( cb ) {
	var now = Date.now();

	if ( !lastCommitCheck || ( now - lastCommitCheck ) > ( 5 * 60 * 1000 ) ) {
		lastCommitCheck = now;
		exec( 'git log --max-count=1 --pretty=format:"%H %ci"', { cwd: repoPath }, function ( err, data ) {
			var cobj = data.match( /^([^ ]+) (.*)$/ );
			if (!cobj) {
				console.log("Error, couldn't find the current commit");
				cb(null, null);
			} else {
				lastCommit = cobj[1];
				// convert the timestamp to UTC
				lastCommitTime = new Date(cobj[2]).toISOString();
				//console.log( 'New commit: ', cobj[1], lastCommitTime );
				cb(cobj[1], lastCommitTime);
			}
		} );
	} else {
		cb( lastCommit, lastCommitTime );
	}
};

var postResult = function( err, result, prefix, title, finalCB, cb ) {
	getGitCommit( function ( newCommit, newTime ) {
		if (!newCommit) {
			console.log("Exiting, couldn't find the current commit");
			process.exit(1);
		}

		if ( err ) {
			result =
				'<error type="' + err.name + '">' +
				err.toString() +
				'</error>';
		}

		result = qs.stringify( { results: result, commit: newCommit, ctime: newTime } );

		var requestOptions = {
			host: config.server.host,
			port: config.server.port,
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'Content-Length': result.length
			},
			path: '/result/' + encodeURIComponent( title ) + '/' + prefix,
			method: 'POST'
		};

		var req = http.request( requestOptions, function ( res ) {
			res.on( 'end', function () {
				if ( finalCB ) {
					finalCB();
				} else {
					cb( 'start' );
				}
			} );
			res.resume();
		} );

		req.write( result, 'utf8' );
		req.end();
	} );
};

var callbackOmnibus = function(which) {
	var args = Array.prototype.slice.call(arguments);
	var prefix, title;
	switch ( args.shift() ) {
		case 'runTest':
			prefix = args[0]; title = args[1];
			console.log( 'Running a test on', prefix + ':' + title, '....' );
			args.unshift( callbackOmnibus );
			runTest.apply( null, args );
			break;

		case 'postResult':
			prefix = args[2]; title = args[3];
			console.log( 'Posting a result for', prefix + ':' + title, '....' );
			args.push( callbackOmnibus );
			postResult.apply( null, args );
			break;

		case 'start':
			getGitCommit( function ( latestCommit ) {
				if ( latestCommit !== commit ) {
					console.log( 'Exiting because the commit hash changed' );
					process.exit( 0 );
				}

				getTitle( callbackOmnibus );
			} );
			break;

		default:
			console.assert(false, 'Bad callback argument: '+which);
	}
};

if ( typeof module === 'object' ) {
	module.exports.getTitle = getTitle;
	module.exports.runTest = runTest;
	module.exports.postResult = postResult;
}

if ( module && !module.parent ) {
	var getGitCommitCb = function ( commitHash, commitTime ) {
		commit = commitHash;
		ctime = commitTime;
		callbackOmnibus('start');
	};

    // Enable heap dumps in /tmp on kill -USR2.
    // See https://github.com/bnoordhuis/node-heapdump/
    // For node 0.6/0.8: npm install heapdump@0.1.0
    // For 0.10: npm install heapdump
    process.on('SIGUSR2', function() {
        var heapdump = require('heapdump');
        console.error('SIGUSR2 received! Writing snapshot.');
        process.chdir('/tmp');
        heapdump.writeSnapshot();
    });

	if ( !config.parsoidURL ) {
		// If no Parsoid server was passed, start our own
		parsoidURL = apiServer.startParsoidServer( {quiet: true}, function( url ) {
			parsoidURL = url;
			getGitCommit( getGitCommitCb );
		} );
	} else {
		getGitCommit( getGitCommitCb );
	}
}
