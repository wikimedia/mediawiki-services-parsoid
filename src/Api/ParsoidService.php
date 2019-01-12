/**
 * Simple Parsoid web service.
 * @module
 */

'use strict';

require('../../core-upgrade.js');

// global includes
var busboy = require('connect-busboy');
var compression = require('compression');
var express = require('express');
var favicon = require('serve-favicon');
var finalHandler = require('finalhandler');
var hbs = require('express-handlebars');
var workerFarm = require('worker-farm');
var path = require('path');
var os = require('os');

var Promise = require('../utils/promise.js');
var ParsoidConfig = require('../config/ParsoidConfig.js').ParsoidConfig;
var parseJsPath = require.resolve('../parse.js');
var JSUtils = require('../utils/jsutils.js').JSUtils;

/**
 * ParsoidService
 *
 * For more details on the HTTP api, see the [guide]{@tutorial apiuse}.
 * @alias module:api/ParsoidService
 */
var ParsoidService = module.exports = {};

/**
 * Instantiates an [express](http://expressjs.com/) server
 * to handle HTTP requests and begins listening on the configured port.
 *
 * WARNING: {@link processLogger} is not necessarily an instance of {@link Logger}.
 * The interface is merely that exposed by service-runner, `log(level, info)`.
 * Don't expect it to exit after you've logged "fatal" and other such things.
 *
 * @method
 * @param {Object} parsoidOptions
 * @param {Object} processLogger
 * @return {Promise} server
 * @alias module:api/ParsoidService.init
 */
ParsoidService.init = Promise.async(function *(parsoidOptions, processLogger) {
	processLogger.log('info', 'loading ...');

	var parsoidConfig = new ParsoidConfig(null, parsoidOptions);

	// Get host and port from the environment, if available
	// note: in production, the port is exposed via the 'port' config stanza and
	// 'PARSOID_PORT' env var, while 'serverPort' and 'PORT' are the legacy option
	// and env var names
	var port = parsoidConfig.port || process.env.PARSOID_PORT
		|| parsoidConfig.serverPort || process.env.PORT || 8000;

	// default bind all
	// note: in production the interface is specified via the 'interface' option,
	// and 'serverInterface' is the legacy option name
	var host = parsoidConfig.interface || parsoidConfig.serverInterface || process.env.INTERFACE;

	var parse, workers;
	if (parsoidConfig.useWorker) {
		var numWorkers = parsoidConfig.cpu_workers ||
			Math.ceil(os.cpus().length / (parsoidConfig.num_workers || 1)) + 1;

		var farmOptions = {
			maxConcurrentWorkers: numWorkers,
			maxConcurrentCallsPerWorker: 1,
			maxConcurrentCalls: parsoidConfig.maxConcurrentCalls * numWorkers,
			maxCallTime: parsoidConfig.timeouts.request,
			// Crashes will retry, timeouts won't, as far as testing showed,
			// but it's documented differently.  Anyways, we don't want retries.
			maxRetries: 0,
			autoStart: true,
		};
		workers = workerFarm(farmOptions, parseJsPath);
		parse = Promise.promisify(workers);
	} else {
		parse = require(parseJsPath);
	}

	var app = express();

	// Default express to production.
	app.set('env', process.env.NODE_ENV || 'production');

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
	app.use(express.json({
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

	// Allow cross-domain requests (CORS) so that parsoid service can be used
	// by third-party sites.
	if (parsoidConfig.allowCORS) {
		app.use(function(req, res, next) {
			res.set('Access-Control-Allow-Origin', parsoidConfig.allowCORS);
			next();
		});
	}

	// just a timer
	app.use(function(req, res, next) {
		res.locals.start = JSUtils.startTime();
		next();
	});

	// Log unhandleds errors passed along with our logger.
	var logError = function(err, req, res) {
		var logger = res.locals.env ? res.locals.env.logger : processLogger;
		var args = ['warn', req.method, req.originalUrl, err];
		if (err.type === 'entity.too.large') {
			// Add the expected length of the stream.
			args.push('expected: ' + err.expected);
		}
		logger.log.apply(logger, args);
	};

	app.use(function(err, req, res, next) {
		var done = finalHandler(req, res, { onerror: logError });
		done(err);
	});

	// Count http error codes
	app.use(function(req, res, next) {
		var metrics = parsoidConfig.metrics;
		if (metrics) {
			var send;
			var clear = function() {
				res.removeListener('finish', send);
				res.removeListener('close', clear);
				res.removeListener('error', clear);
			};
			send = function() {
				var code = String(res.statusCode || 'unknown');
				if (code !== '200') {
					metrics.increment('http.status.' + code);
				}
				clear();
			};
			res.once('finish', send);
			res.once('close', clear);
			res.once('error', clear);
		}
		next();
	});

	// Routes

	var routes = require('./routes')(parsoidConfig, processLogger, parsoidOptions, parse);

	var a = routes.acceptable;
	var p = routes.parserEnvMw;
	var u = routes.updateActiveRequests;
	var v3 = routes.v3Middle;

	app.get('/', routes.home);
	app.get('/robots.txt', routes.robots);
	app.get('/version', routes.version);
	app.get('/_version', routes.version);  // for backwards compat.

	// v3 API routes
	app.get('/:domain/v3/page/:format/:title/:revision?', v3, u, p, a, routes.v3Get);
	app.post('/:domain/v3/transform/:from/to/:format/:title?/:revision?', v3, u, p, a, routes.v3Post);

	// private routes
	if (parsoidConfig.devAPI) {
		var internal = require('./internal')(parsoidConfig, processLogger);
		var i = internal.middle;
		app.get('/_html/:prefix?/:title?', i, p, internal.html2wtForm);
		app.get('/_wikitext/:prefix?/:title?', i, p, internal.wt2htmlForm);
		app.get('/_rt/:prefix?/:title?', i, p, internal.roundtripTesting);
		app.get('/_rtve/:prefix?/:title?', i, p, internal.roundtripTestingNL);
		app.get('/_rtselser/:prefix?/:title?', i, p, internal.roundtripSelser);
		app.get('/_rtform/:prefix?/:title?', i, p, internal.getRtForm);
		app.post('/_rtform/:prefix?/:title?', i, p, internal.postRtForm);
	}

	var server;
	yield new Promise(function(resolve, reject) {
		app.on('error', function(err) {
			processLogger.log('error', err);
			reject(err);
		});
		server = app.listen(port, host, resolve);
	});
	port = server.address().port;
	processLogger.log('info', `ready on ${host || ''}:${port}`);
	return {
		close: Promise.async(function *() {
			try {
				yield Promise.promisify(server.close, false, server)();
			} finally {
				if (parsoidConfig.useWorker) { workerFarm.end(workers); }
				// The conf cache is reused across requests, but shouldn't
				// be shared between services.  This conflict arises when
				// service-runner num_workers is zero, and mocha spawns
				// services in succession.
				require('../config/MWParserEnvironment.js').MWParserEnvironment.resetConfCache();
			}
		}),
		port: port,
	};
});
