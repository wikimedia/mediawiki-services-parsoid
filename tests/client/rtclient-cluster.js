#!/usr/bin/env node
'use strict';
require('../../lib/core-upgrade.js');

var cluster = require('cluster');
var path = require('path');

var opts = require('yargs')
	.default({
		// By default, start one rtclient + api server per core.
		c: require('os').cpus().length,
	})
	.alias('c', 'children').argv;

if (!module.parent) {
	var numClients = opts.c;

	cluster.setupMaster({
		exec: path.join(__dirname, 'client.js'),
		args: opts._,
	});

	console.log("rtclient-cluster initializing", numClients, "rtclients");
	for (var i = 0; i < numClients; i++) {
		cluster.fork();
	}

	cluster.on('exit', function(worker, code, signal) {
		if (!worker.suicide) {
			var exitCode = worker.process.exitCode;
			console.log('rtclient', worker.process.pid,
				'died (' + exitCode + '), restarting.');
			cluster.fork();
		}
	});

	var shutdownCluster = function() {
		console.log('rtclient cluster shutting down, killing all rtclients');
		var workers = cluster.workers;
		Object.keys(workers).forEach(function(id) {
			console.log('Killing rtclient', id);
			workers[id].kill('SIGKILL');
		});
		console.log('Done killing rtclients, exiting rtclient-cluster.');
		process.exit(0);
	};

	process.on('SIGINT', shutdownCluster);
	process.on('SIGTERM', shutdownCluster);
}
