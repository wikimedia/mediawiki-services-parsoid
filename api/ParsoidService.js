/*
 * Simple Parsoid web service.
 */
'use strict';
require('../lib/core-upgrade.js');

// global includes
var express = require('express');
var compression = require('compression');
var hbs = require('express-handlebars');
var favicon = require('serve-favicon');
var busboy = require('connect-busboy');
var bodyParser = require('body-parser');
var cluster = require('cluster');
var path = require('path');
var util = require('util');
var uuid = require('node-uuid').v4;

/**
 * ParsoidService instantiates an [express](http://expressjs.com/) server
 * to handle HTTP requests.
 *
 * For more details on the HTTP api, see the
 * [guide](#!/guide/apiuse).
 *
 * @class
 * @constructor
 * @param {ParsoidConfig} parsoidConfig
 * @param {Logger} processLogger
 */
function ParsoidService(parsoidConfig, processLogger) {
	processLogger.log('info', 'loading ...');

	// Load routes
	var routes = require('./routes')(parsoidConfig);

	var app = express();

	// view engine
	var ve = hbs.create({
		defaultLayout: 'layout',
		layoutsDir: path.join(__dirname, '/views'),
		extname: '.html',
		helpers: {
			// block helper to reference js files in page head.
			jsFiles: function(options) {
				this.javascripts = options.fn(this);
			},
		},
	});
	app.set('views', path.join(__dirname, '/views'));
	app.set('view engine', 'html');
	app.engine('html', ve.engine);

	// serve static files
	app.use('/static', express.static(path.join(__dirname, '/static')));

	// favicon
	app.use(favicon(path.join(__dirname, 'favicon.ico')));

	// support gzip / deflate transfer-encoding
	app.use(compression());

	// application/json
	app.use(bodyParser.json({
		limit: parsoidConfig.maxFormSize,
	}));

	// application/x-www-form-urlencoded
	// multipart/form-data
	app.use(busboy({
		limits: {
			fields: 10,
			fieldSize: parsoidConfig.maxFormSize,
		},
	}));
	app.use(function(req, res, next) {
		req.body = req.body || {};
		if (!req.busboy) {
			return next();
		}
		req.busboy.on('field', function(field, val) {
			req.body[field] = val;
		});
		req.busboy.on('finish', function() {
			next();
		});
		req.pipe(req.busboy);
	});

	// timeout ids, used internally to track runaway processes
	var buf = new Buffer(16);
	app.use(function(req, res, next) {
		uuid(null, buf);
		res.locals.timeoutId = buf.toString('hex');
		next();
	});

	// just a timer
	app.use(function(req, res, next) {
		res.locals.start = Date.now();
		next();
	});

	// Catch errors
	app.on('error', function(err) {
		if (err.errno === 'EADDRINUSE') {
			processLogger.log('error',
				util.format('Port %d is already in use. Exiting.', port));
			cluster.worker.disconnect();
		} else {
			processLogger.log('error', err);
		}
	});


	// Routes

	var p = routes.parserEnvMw;
	var v1 = routes.v1Middle;
	var v2 = routes.v2Middle;
	var v3 = routes.v3Middle;

	function re(str) { return new RegExp(str); }

	// Regexp that matches to all interwikis accepted by the API.
	var mwApiRe = parsoidConfig.mwApiRegexp;

	app.get('/', routes.home);
	app.get('/_version', routes.version);
	app.get('/robots.txt', routes.robots);

	// private routes
	app.get(re('^/_html/(?:(' + mwApiRe + ')/(.*))?'), v1, p, routes.html2wtForm);
	app.get(re('^/_wikitext/(?:(' + mwApiRe + ')/(.*))?'), v1, p, routes.wt2htmlForm);
	app.get(re('^/_rt/(?:(' + mwApiRe + ')/(.*))?'), v1, p, routes.roundtripTesting);
	app.get(re('^/_rtve/(' + mwApiRe + ')/(.*)'), v1, p, routes.roundtripTestingNL);
	app.get(re('^/_rtselser/(' + mwApiRe + ')/(.*)'), v1, p, routes.roundtripSelser);
	app.get(re('^/_rtform/(?:(' + mwApiRe + ')/(.*))?'), v1, p, routes.getRtForm);
	app.post(re('^/_rtform/(?:(' + mwApiRe + ')/(.*))?'), v1, p, routes.postRtForm);

	// Put v3 routes before v1 routes so they have a chance to match even
	// if the user configured prefix === domain.  The 'v3' in the path will
	// disambiguate.  (Article titles should be capitalized, which will
	// prevent an article named 'v3' from being an additional source of
	// ambiguity.)

	// v3 API routes
	app.get('/:domain/v3/page/:format/:title/:revision?', v3, p, routes.v3Get);
	app.post('/:domain/v3/transform/:from/to/:format/:title?/:revision?', v3, p, routes.v3Post);

	// v1 API routes
	app.get(re('^/(' + mwApiRe + ')/(.*)'), v1, p, routes.v1Get);
	app.post(re('^/(' + mwApiRe + ')/(.*)'), v1, p, routes.v1Post);

	// v2 API routes
	app.get('/v2/:domain/:format/:title/:revision?', v2, p, routes.v2Get);
	app.post('/v2/:domain/:format/:title?/:revision?', v2, p, routes.v2Post);

	// Get host and port from the environment, if available
	var port = parsoidConfig.serverPort || process.env.PORT || 8000;
	// default bind all
	var host = parsoidConfig.serverInterface || process.env.INTERFACE;

	var server = app.listen(port, host, function() {
		port = server.address().port;
		processLogger.log("info", util.format("ready on %s:%s", host || "", port));
		if (process.send) {
			// let cluster master know we've started & are ready to go.
			process.send({ type: 'startup', host: host, port: port });
		}
	});
}

module.exports = {
	ParsoidService: ParsoidService,
};
