#!/usr/bin/env node
/**
 * A very basic cluster-based server runner. Restarts failed workers, but does
 * not much else right now.
 */

var cluster = require('cluster');
var app = require('./ParserService.js');
// Start a few more workers than there are cpus visible to the OS, so that we
// get some degree of parallelism even on single-core systems. A single
// long-running request would otherwise hold up all concurrent short requests.
var numCPUs = require('os').cpus().length + 3;

if (cluster.isMaster) {
  // Fork workers.
  for (var i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('death', function(worker) {
    if(!worker.suicide) {
      console.log('worker ' + worker.pid + ' died, restarting.');
      // restart worker
      cluster.fork();
    }
  });
  process.on('SIGTERM', function() {
    console.log('master shutting down, killing workers');
    var workers = cluster.workers;
    if (!workers) { throw new Error("Force killing node 0.6.x"); }
    Object.keys(workers).forEach(function(id) {
        console.log('Killing worker ' + id);
        workers[id].destroy();
    });
    console.log('Done killing workers, bye');
    process.exit(1);
  } );
} else {
  process.on('SIGTERM', function() {
    console.log('Worker shutting down');
    process.exit(1);
  });
  // when running on appfog.com the listen port for the app
  // is passed in an environment variable.  Most users can ignore this!
  app.listen(process.env.VCAP_APP_PORT || 8000);
}
