/**
 * Simple Parsoid web service.
 */
"use strict";

require('../lib/core-upgrade.js');

// global includes
var express = require('express'),
	compression = require('compression'),
	hbs = require('handlebars'),
	cluster = require('cluster'),
	path = require('path'),
	util = require('util'),
	uuid = require('node-uuid').v4;


function ParsoidService( parsoidConfig, processLogger ) {
	processLogger.log( "info", "loading ..." );

	// Load routes
	var routes = require('./routes')( parsoidConfig );

	var app = express.createServer();

	// view engine
	app.set('views', path.join(__dirname, '/views'));
	app.set('view engine', 'html');
	app.register('html', hbs);

	// block helper to reference js files in page head.
	hbs.registerHelper('jsFiles', function(options){
		this.javascripts = options.fn(this);
	});

	// serve static files
	app.use("/static", express.static(path.join(__dirname, "/static")));

	// favicon
	app.use(express.favicon(path.join(__dirname, "favicon.ico")));

	// Increase the form field size limit from the 2M default.
	app.use(express.bodyParser({ maxFieldsSize: 15 * 1024 * 1024 }));

	// Support gzip / deflate transfer-encoding
	app.use(compression());

	// limit upload file size
	app.use(express.limit('15mb'));

	// request ids
	var buf = new Buffer(16);
	app.use(function(req, res, next) {
		if(req.headers && req.headers['x-request-id']) {
			res.local('reqId', req.headers['x-request-id']);
		} else {
			uuid(null, buf);
			res.local('reqId', buf.toString('hex'));
		}
		next();
	});

	// just a timer
	app.use(function(req, res, next) {
		res.local('start', Date.now());
		next();
	});

	// Catch errors
	app.on('error', function( err ) {
		if ( err.errno === "EADDRINUSE" ) {
			processLogger.log( "error", util.format( "Port %d is already in use. Exiting.", port ) );
			cluster.worker.disconnect();
		} else {
			processLogger.log( "error", err );
		}
	});


	// Routes

	var i = routes.interParams,
		p = routes.parserEnvMw,
		v = routes.v2Middle;

	function re(str) { return new RegExp(str); }

	// Regexp that matches to all interwikis accepted by the API.
	var iwRe = parsoidConfig.interwikiRegexp;

	app.get( '/', routes.home );
	app.get( '/_version', routes.version );
	app.get( '/robots.txt', routes.robots );

	app.get(  re('^/((?:_rt|_rtve)/)?(' + iwRe + '):(.*)$'), routes.redirectOldStyle );
	app.get(  re('^/_html/(?:(' + iwRe + ')/(.*))?'), i, p, routes.html2wtForm );
	app.get(  re('^/_wikitext/(?:(' + iwRe + ')/(.*))?'), i, p, routes.wt2htmlForm );
	app.get(  re('^/_rt/(?:(' + iwRe + ')/(.*))?'), i, p, routes.roundtripTesting );
	app.get(  re('^/_rtve/(' + iwRe + ')/(.*)'), i, p, routes.roundtripTestingNL );
	app.get(  re('^/_rtselser/(' + iwRe + ')/(.*)'), i, p, routes.roundtripSelser );
	app.get(  re('^/_rtform/(?:(' + iwRe + ')/(.*))?'), i, p, routes.get_rtForm );
	app.post( re('^/_rtform/(?:(' + iwRe + ')/(.*))?'), i, p, routes.post_rtForm );
	app.get(  re('^/(' + iwRe + ')/(.*)'), i, p, routes.get_article );
	app.post( re('^/(' + iwRe + ')/(.*)'), i, p, routes.post_article );

	// v2 API routes
	app.get(  '/v2/:domain/:format/:title/:revision?', v, p, routes.v2_get );
	app.post( '/v2/:domain/:format/:title?/:revision?', v, p, routes.v2_post );


	// Get host and port from the environment, if available
	var port = parsoidConfig.serverPort || process.env.PORT || 8000;
	// default bind all
	var host = parsoidConfig.serverInterface || process.env.INTERFACE;

	app.listen( port, host, function() {
		processLogger.log( "info", util.format( "ready on %s:%s", host || "", port ) );
		if (process.send) {
			// let cluster master know we've started & are ready to go.
			process.send({ type: 'startup', host: host, port: port });
		}
	} );
}

module.exports = {
	ParsoidService: ParsoidService
};
