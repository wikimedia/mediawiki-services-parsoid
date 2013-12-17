#!/usr/bin/env node
"use strict";
/**
 * Manages a Parsoid server for testing.
 */

var child_process = require( 'child_process' );

var forkedServer;

/**
 * Starts a Parsoid server on passed port or a random port if none passed,
 * @return The URL of the created server
 */
var startParsoidServer = function ( port ) {
	if ( !port ) {
		port = 9000 + Math.floor( Math.random() * 100 );
	}

	forkedServer = child_process.fork( __dirname + '/../api/server.js',
		[ '-c', '1' ], { env:
			{
				VCAP_APP_PORT: port,
				NODE_PATH: process.env.NODE_PATH
			}
		} );

	// If this process dies, kill our Parsoid server
	var weDied = function () {
		forkedServer.removeListener( 'exit', startParsoidServer );
		forkedServer.kill();
	};
	process.on( 'exit', weDied );

	// If it dies on its own, restart it
	forkedServer.on( 'exit', function( ) {
		process.removeListener( 'exit', weDied );
		// Don't pass a port, so it changes in case the problem was an already
		// occupied one
		startParsoidServer();
	} );

	return 'http://localhost:' + port.toString() + '/';
};

var stopParsoidServer = function () {
	if ( forkedServer ) {
		forkedServer.removeListener( 'exit', startParsoidServer );
		forkedServer.kill();
	}
};

module.exports = {
	startParsoidServer: startParsoidServer,
	stopParsoidServer: stopParsoidServer
};
