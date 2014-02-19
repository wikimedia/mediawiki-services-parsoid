#!/usr/bin/env node
"use strict";

/**
 * Manages different servers for testing.
 * Uses port randomization to make sure we can use multiple servers concurrently.
 */

var child_process = require( 'child_process' ),
	Util = require('../lib/mediawiki.Util.js').Util,
	path = require( 'path' );

var forkedServer;
var forkedServerURL;

/**
 * Starts a server on passed port or a random port if none passed.
 * The callback will get the URL of the started server.
 */
var startServer = function ( opts, cb, port ) {
	if (!opts) {
		throw "Please provide server options.";
	}

	// For now, we always assume that retries are due to port conflicts
	if (!port || opts.retrying) {
		port = opts.portBase + Math.floor( Math.random() * 100 );
	}

	forkedServerURL = 'http://' + opts.iface + ':' + port.toString() + opts.urlPath;

	if (!opts.quiet) {
		console.log( "Starting " + opts.serverName + " server at", forkedServerURL );
	}

	forkedServer = child_process.fork(__dirname + opts.filePath,
		opts.serverArgv,
		{
			env: {
				PORT: port,
				INTERFACE: opts.iface,
				NODE_PATH: process.env.NODE_PATH
			}
		}
	);

	// If this process dies, kill our server
	var weDied = function () {
		forkedServer.removeListener( 'exit', startServer );
		forkedServer.kill();
	};
	process.on( 'exit', weDied );

	// If it dies on its own, restart it
	forkedServer.on( 'exit', function( ) {
		forkedServer = null;
		process.removeListener( 'exit', weDied );
		opts.retrying = true;
		startServer(opts, cb);
	} );

	if (!opts.retrying) {
		// HACK HACK HACK!!
		//
		// It is possible that we get into this callback in the time
		// between when the server is started and when it exits because
		// of port conflict. Since concurrent uses are expected to be
		// somewhat uncommon, this is a simple enough solution that mostly
		// works in a most of these concurrent uses.
		//
		// A real solution would be to implement an 'alive' endpoint
		// or something that lets apiServer.js know that the server
		// is up and running successfully and use that to pass back
		// the server url. But, that is more work and it is unclear
		// if we need it.
		var waitAndCB = function() {
			if (forkedServer) {
				cb(forkedServerURL, forkedServer);
			} else {
				setTimeout(waitAndCB, 2000);
			}
		};

		// Wait 2 seconds to make sure it has had time to start
		setTimeout(waitAndCB, 2000);
	}
};

var stopServer = function () {
	if ( forkedServer ) {
		forkedServer.removeListener( 'exit', startServer );
		forkedServer.kill();
	}
};

var parsoidServerOpts = {
	serverName: "Parsoid",
	iface: "localhost",
	portBase: 9000,
	urlPath: "/",
	filePath: "/../api/server.js",
	serverArgv: [
		'--num-workers', '1',
		'--config', path.resolve( __dirname, './test.localsettings.js' )
	],
	serverEnv: {}
};

var startParsoidServer = function (opts, cb) {
	opts = !opts ? parsoidServerOpts : Util.extendProps(opts, parsoidServerOpts);
	startServer(opts, cb, opts.port);
};

var mockAPIServerOpts = {
	serverName: "Mock API",
	iface: "localhost",
	portBase: 7000,
	urlPath: "/api.php",
	filePath: "/../tests/mockAPI.js",
	serverArgv: [],
	serverEnv: { silent: true }
};

var startMockAPIServer = function (opts, cb) {
	opts = !opts ? mockAPIServerOpts : Util.extendProps(opts, mockAPIServerOpts);
	startServer(opts, cb, opts.port);
};

module.exports = {
	startServer: startServer,
	stopServer: stopServer,
	startParsoidServer: startParsoidServer,
	startMockAPIServer: startMockAPIServer
};
