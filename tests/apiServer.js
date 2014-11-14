#!/usr/bin/env node
"use strict";

/**
 * Manages different servers for testing.
 * Uses port randomization to make sure we can use multiple servers concurrently.
 */

require('es6-shim');

var child_process = require( 'child_process' ),
	Util = require('../lib/mediawiki.Util.js').Util,
	JSUtils = require('../lib/jsutils.js').JSUtils,
	path = require( 'path' );

// Keep all started servers in a map indexed by the url
var forkedServers = new Map(),
	exiting = false;

var stopServer = function (url) {
	var forkedServer = forkedServers.get(url);
	if (forkedServer) {
		// Prevent restart if we explicitly stop it
		forkedServer.child.removeAllListeners('exit');
		forkedServer.child.kill();
		forkedServers.delete(url);
	}
};

var stopAllServers = function () {
	forkedServers.forEach(function (forkedServer, url) {
		stopServer(url);
	});
};

/**
 * Make sure the servers are killed if the process exits.
 */
process.on('exit', function() {
		exiting = true;
		stopAllServers();
});

var exitOnProcessTerm = function (res) {
	var stopAndExit = function () {
		process.exit(res || 0);
	};
	process.on('SIGINT', stopAndExit);
	process.on('SIGTERM', stopAndExit);
	process.on('uncaughtException', function (e) {
		console.log(e.stack);
		stopAndExit();
	});
};

/**
 * Starts a server on passed port or a random port if none passed.
 * The callback will get the URL of the started server.
 */
var startServer = function( opts, retrying, cb ) {
	// Don't create callback chains when invoked recursively
	if ( !cb || !cb.promise ) { cb = JSUtils.mkPromised( cb ); }

	var url, forkedServer = {}, port;
	if (!opts) {
		throw "Please provide server options.";
	}
	forkedServer.opts = opts;
	port = opts.port;

	// For now, we always assume that retries are due to port conflicts
	if (!port) {
		port = opts.portBase + Math.floor( Math.random() * 100 );
	}

	url = 'http://' + opts.iface + ':' + port.toString() + opts.urlPath;
	if (opts.port && forkedServers.has(url)) {
		// We already have a server there!
		return cb( "There's already a server running at that port." );
	}

	if (!opts.quiet) {
		console.log( "Starting %s server at %s", opts.serverName, url );
	}

	forkedServer.child = child_process.fork(__dirname + opts.filePath,
		opts.serverArgv,
		{
			env: {
				PORT: port,
				INTERFACE: opts.iface,
				NODE_PATH: process.env.NODE_PATH,
				PARSOID_MOCKAPI_URL: opts.mockUrl
			}
		}
	);

	forkedServers.set(url, forkedServer);

	// If it dies on its own, restart it. The most common cause will be that the
	// port was already in use, so if no port was specified then a new random
	// one will be selected.
	forkedServer.child.on('exit', function() {
		if (exiting) {
			return;
		}
		console.warn('Restarting server at', url);
		forkedServers.delete(url);
		startServer(opts, true, cb);
	});

	if (!retrying) {
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
			if (forkedServer.child) {
				cb( null, { url: url, child: forkedServer.child } );
			} else {
				setTimeout(waitAndCB, 2000);
			}
		};

		// Wait 2 seconds to make sure it has had time to start
		setTimeout(waitAndCB, 2000);
	}

	return cb.promise;
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
	return startServer(opts, false, cb);
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
	return startServer(opts, false, cb);
};

module.exports = {
	startServer: startServer,
	stopServer: stopServer,
	stopAllServers: stopAllServers,
	startParsoidServer: startParsoidServer,
	startMockAPIServer: startMockAPIServer,
	exitOnProcessTerm: exitOnProcessTerm
};
