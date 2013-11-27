#!/usr/bin/env node
/**
 * A very basic cluster-based server runner. Restarts failed workers, but does
 * not much else right now.
 */

var cluster = require('cluster');

if (cluster.isMaster) {

	// process arguments
	var opts = require( "optimist" )
		.usage( "Usage: $0 [-h|-v] [--param[=val]]" )
		.default({

			// Start a few more workers than there are cpus visible to the OS, 
			// so that we get some degree of parallelism even on single-core
			// systems. A single long-running request would otherwise hold up
			// all concurrent short requests.
			c: require( "os" ).cpus().length + 3,

			v: false,
			h: false

		})
		.boolean( [ "h", "v" ] )
		.alias( "h", "help" )
		.alias( "v", "version" )
		.alias( "c", "children" );

	var argv = opts.argv,
		fs = require( "fs" ),
		path = require( "path" ),
		meta = require( path.join( __dirname, "../package.json" ) );

	// help
	if ( argv.h ) {
		opts.showHelp();
		process.exit( 0 );
	}

	// version
	if ( argv.v ) {
		console.log( meta.name + " " + meta.version );
		process.exit( 0 );
	}

	// Fork workers.
	console.log('master(' + process.pid + ') initializing ' +
				argv.c + ' workers');
	for (var i = 0; i < argv.c; i++) {
		cluster.fork();
	}

	cluster.on('exit', function(worker, code, signal) {
		if (!worker.suicide) {
			var exitCode = worker.process.exitCode;
			console.log('worker', worker.process.pid,
				'died ('+exitCode+'), restarting.');
			cluster.fork();
		}
	});

	var shutdown_master = function() {
		console.log('master shutting down, killing workers');
		var workers = cluster.workers;
		Object.keys(workers).forEach(function(id) {
			console.log('Killing worker ' + id);
			workers[id].destroy();
		});
		console.log('Done killing workers');
		console.log('Exiting master');
		process.exit(0);
	};

	process.on('SIGINT', shutdown_master);
	process.on('SIGTERM', shutdown_master);

} else {
	// Worker.
	process.on('SIGTERM', function() {
		console.log('Worker shutting down');
		process.exit(0);
	});

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

	var app = require('./ParserService.js');
	// when running on appfog.com the listen port for the app
	// is passed in an environment variable.  Most users can ignore this!
	app.listen(process.env.VCAP_APP_PORT || 8000);
}
