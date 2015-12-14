'use strict';
require('../core-upgrade.js');

/**
 * Manages different servers for testing.
 * Uses port randomization to make sure we can use multiple servers concurrently.
 */

var childProcess = require('child_process');
var path = require('path');

var Promise = require('../lib/utils/promise.js');
var Util = require('../lib/utils/Util.js').Util;

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
 * @return {Promise}
 *   A promise which resolves to an object with two properties: `url`
 *   (the url of the started server) and `child` (the ChildProcess object
 *   for the started server).  The promise only resolves after the server
 *   is up and running (a 'startup' message has been received).
 */
var startServer = function(opts) {
	return new Promise(function(resolve, reject) {

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
			resolve(startServer(opts));
		});

		forkedServer.child.on('message', function(m) {
			if (m && m.type === 'startup') {
				url = 'http://' + opts.iface + ':' + m.port.toString() + opts.urlPath;
				opts.port = m.port;
				forkedServers.set(url, forkedServer);
				resolve({ url: url, child: forkedServer.child });
			}
		});
	});
};

var parsoidServerOpts = {
	serverName: "Parsoid",
	iface: "localhost",
	port: 0,  // Select a port at random.
	urlPath: "/",
	filePath: '/../bin/server.js',
	serverArgv: [
		// we want the cluster master so that timeouts on stuck titles lead to a restart.
		'--num-workers', '1',
		'--config', path.resolve(__dirname, './rttest.localsettings.js'),
	],
	serverEnv: {},
};

// Returns a Promise. (see startServer)
var startParsoidServer = function(opts) {
	opts = !opts ? parsoidServerOpts : Util.extendProps(opts, parsoidServerOpts);
	return startServer(opts);
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

// Returns a Promise (see startServer)
var startMockAPIServer = function(opts) {
	opts = !opts ? mockAPIServerOpts : Util.extendProps(opts, mockAPIServerOpts);
	return startServer(opts);
};

module.exports = {
	// These functions aren't currently used outside this module, so
	// don't export them for now.
	/*
	startServer: startServer,
	stopServer: stopServer,
	*/
	stopAllServers: stopAllServers,
	startParsoidServer: startParsoidServer,
	startMockAPIServer: startMockAPIServer,
	exitOnProcessTerm: exitOnProcessTerm,
};
