'use strict';
require('../lib/core-upgrade.js');

/**
 * Manages different servers for testing.
 * Uses port randomization to make sure we can use multiple servers concurrently.
 */

var childProcess = require('child_process');
var Util = require('../lib/mediawiki.Util.js').Util;
var JSUtils = require('../lib/jsutils.js').JSUtils;
var path = require('path');

// Keep all started servers in a map indexed by the url
var forkedServers = new Map();
var exiting = false;

var stopServer = function(url) {
	var forkedServer = forkedServers.get(url);
	if (forkedServer) {
		// Prevent restart if we explicitly stop it
		forkedServer.child.removeAllListeners('exit');
		forkedServer.child.kill();
		forkedServers.delete(url);
	}
};

var stopAllServers = function() {
	forkedServers.forEach(function(forkedServer, url) {
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

var exitOnProcessTerm = function(res) {
	var stopAndExit = function() {
		process.exit(res || 0);
	};
	process.on('SIGINT', stopAndExit);
	process.on('SIGTERM', stopAndExit);
	process.on('uncaughtException', function(e) {
		console.log(e.stack);
		stopAndExit();
	});
};

/**
 * Starts a server on passed port or a random port if none passed.
 * The callback will get the URL of the started server.
 */
var startServer = function(opts, retrying, cb) {
	// Don't create callback chains when invoked recursively
	if (!cb || !cb.promise) { cb = JSUtils.mkPromised(cb); }

	if (!opts) {
		throw "Please provide server options.";
	}

	var forkedServer = { opts: opts };
	var port = opts.port;

	// For now, we always assume that retries are due to port conflicts
	if (!port) {
		port = opts.portBase + Math.floor( Math.random() * 100 );
	}

	var url = 'http://' + opts.iface + ':' + port.toString() + opts.urlPath;
	if (opts.port && forkedServers.has(url)) {
		// We already have a server there!
		return cb( "There's already a server running at that port." );
	}

	if (!opts.quiet) {
		console.log( "Starting %s server at %s", opts.serverName, url );
	}

	forkedServer.child = childProcess.fork(__dirname + opts.filePath,
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

	forkedServer.child.on('message', function(m) {
		if (m && m.type && m.type === 'startup' && cb) {
			cb( null, { url: url, child: forkedServer.child } );
			cb = null; // prevent invoking cb again on restart
		}
	});

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
		'--config', path.resolve( __dirname, './rttest.localsettings.js' )
	],
	serverEnv: {}
};

// Returns a Promise; the `cb` parameter is optional (for legacy use)
var startParsoidServer = function(opts, cb) {
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

// Returns a Promise; the `cb` parameter is optional (for legacy use)
var startMockAPIServer = function(opts, cb) {
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
