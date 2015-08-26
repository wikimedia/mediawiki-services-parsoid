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
		process.exit(1);
	});
};

/**
 * Starts a server on passed port or a random port if none passed.
 * The callback will get the URL of the started server.
 */
var startServer = function(opts, cb) {
	// Don't create callback chains when invoked recursively
	if (!cb || !cb.promise) { cb = JSUtils.mkPromised(cb); }

	if (!opts) {
		throw "Please provide server options.";
	}

	var forkedServer = { opts: opts };
	var port = opts.port;

	if (port === undefined) {
		// Let the OS choose a random open port.  We'll forward it up the chain
		// with the startup message.
		port = 0;
	}

	// Handle debug port (borrowed from 'createWorkerProcess' in node's
	// own lib/cluster.js)
	var debugPort = process.debugPort + 1;
	var execArgv = opts.execArgv || process.execArgv;
	execArgv.forEach(function(arg, i) {
		var match = arg.match(/^(--debug|--debug-(brk|port))(=\d+)?$/);
		if (match) {
			// defaults to stopping for debugging only in the parent process;
			// set debugBrkInChild in the options if you want to stop for
			// debugging at the first line of the child process as well.
			var which = (match[1] !== '--debug-brk' || opts.debugBrkInChild) ?
				match[1] : '--debug';
			execArgv[i] = which + '=' + debugPort;
		}
	});

	if (!opts.quiet) {
		console.log("Starting %s server.", opts.serverName);
	}

	forkedServer.child = childProcess.fork(
		__dirname + opts.filePath,
		opts.serverArgv,
		{
			env: {
				PORT: port,
				INTERFACE: opts.iface,
				NODE_PATH: process.env.NODE_PATH,
				PARSOID_MOCKAPI_URL: opts.mockUrl || '',
			},
			execArgv: execArgv,
		}
	);

	var url;

	// If it dies on its own, restart it.
	forkedServer.child.on('exit', function() {
		if (exiting) {
			return;
		}
		if (url) {
			console.warn('Restarting server at: ', url);
			forkedServers.delete(url);
		}
		startServer(opts, cb);
	});

	forkedServer.child.on('message', function(m) {
		if (m && m.type === 'startup') {
			url = 'http://' + opts.iface + ':' + m.port.toString() + opts.urlPath;
			opts.port = m.port;
			forkedServers.set(url, forkedServer);
			if (typeof cb === 'function') {
				cb(null, { url: url, child: forkedServer.child });
				cb = null; // prevent invoking cb again on restart
			}
		}
	});

	return cb.promise;
};

var parsoidServerOpts = {
	serverName: "Parsoid",
	iface: "localhost",
	port: 0,  // Select a port at random.
	urlPath: "/",
	filePath: "/../api/server.js",
	serverArgv: [
		// we want the cluster master so that timeouts on stuck titles lead to a restart.
		'--num-workers', '1',
		'--config', path.resolve(__dirname, './rttest.localsettings.js'),
	],
	serverEnv: {},
};

// Returns a Promise; the `cb` parameter is optional (for legacy use)
var startParsoidServer = function(opts, cb) {
	opts = !opts ? parsoidServerOpts : Util.extendProps(opts, parsoidServerOpts);
	return startServer(opts, false, cb);
};

var mockAPIServerOpts = {
	serverName: "Mock API",
	iface: "localhost",
	port: 0,  // Select a port at random.
	urlPath: "/api.php",
	filePath: "/../tests/mockAPI.js",
	serverArgv: [],
	serverEnv: { silent: true },
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
	exitOnProcessTerm: exitOnProcessTerm,
};
