<?php // lint >= 99.9
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * Simple Parsoid web service.
 * @module
 */

namespace Parsoid;

use Parsoid\busboy as busboy;
use Parsoid\compression as compression;
use Parsoid\express as express;
use Parsoid\favicon as favicon;
use Parsoid\finalHandler as finalHandler;
use Parsoid\hbs as hbs;
use Parsoid\workerFarm as workerFarm;

use Parsoid\Promise as Promise;

$ParsoidConfig = require '../config/ParsoidConfig.js'::ParsoidConfig;
$parseJsPath = $require->resolve( '../parse.js' );
$JSUtils = require '../utils/jsutils.js'::JSUtils;

/**
 * ParsoidService
 *
 * For more details on the HTTP api, see the [guide]{@tutorial apiuse}.
 * @alias module:api/ParsoidService
 */
$ParsoidService = $module->exports = [];

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
ParsoidService::init = /* async */function ( $parsoidOptions, $processLogger ) use ( &$ParsoidConfig, &$workerFarm, &$parseJsPath, &$Promise, &$express, &$hbs, &$path, &$favicon, &$compression, &$busboy, &$JSUtils, &$finalHandler ) {
	$processLogger->log( 'info', 'loading ...' );

	$parsoidConfig = new ParsoidConfig( null, $parsoidOptions );

	// Get host and port from the environment, if available
	// note: in production, the port is exposed via the 'port' config stanza and
	// 'PARSOID_PORT' env var, while 'serverPort' and 'PORT' are the legacy option
	// and env var names
	// Get host and port from the environment, if available
	// note: in production, the port is exposed via the 'port' config stanza and
	// 'PARSOID_PORT' env var, while 'serverPort' and 'PORT' are the legacy option
	// and env var names
	$port = $parsoidConfig->port || $process->env->PARSOID_PORT
|| $parsoidConfig->serverPort || $process->env->PORT || 8000;

	// default bind all
	// note: in production the interface is specified via the 'interface' option,
	// and 'serverInterface' is the legacy option name
	// default bind all
	// note: in production the interface is specified via the 'interface' option,
	// and 'serverInterface' is the legacy option name
	$host = $parsoidConfig->interface || $parsoidConfig->serverInterface || $process->env->INTERFACE;

	$parse = null;
$workers = null;
	if ( $parsoidConfig->useWorker ) {
		$numWorkers = $parsoidConfig->cpu_workers
|| ceil( count( $os->cpus() ) / ( $parsoidConfig->num_workers || 1 ) ) + 1;

		$farmOptions = [
			'maxConcurrentWorkers' => $numWorkers,
			'maxConcurrentCallsPerWorker' => 1,
			'maxConcurrentCalls' => $parsoidConfig->maxConcurrentCalls * $numWorkers,
			'maxCallTime' => $parsoidConfig->timeouts->request,
			// Crashes will retry, timeouts won't, as far as testing showed,
			// but it's documented differently.  Anyways, we don't want retries.
			'maxRetries' => 0,
			'autoStart' => true
		];
		$workers = workerFarm::class( $farmOptions, $parseJsPath );
		$parse = Promise::promisify( $workers );
	} else {
		$parse = require $parseJsPath;
	}

	$app = express::class();

	// Default express to production.
	// Default express to production.
	$app->set( 'env', $process->env->NODE_ENV || 'production' );

	// view engine
	// view engine
	$ve = hbs::create( [
			'defaultLayout' => 'layout',
			'layoutsDir' => implode( $__dirname, $path ),
			'extname' => '.html',
			'helpers' => [
				// block helper to reference js files in page head.
				'jsFiles' => function ( $options ) {
					$this->javascripts = $options->fn( $this );
				}
			]
		]
	);
	$app->set( 'views', implode( $__dirname, $path ) );
	$app->set( 'view engine', 'html' );
	$app->engine( 'html', $ve->engine );

	// serve static files
	// serve static files
	$app->use( '/static', express::static( implode( $__dirname, $path ) ) );

	// favicon
	// favicon
	$app->use( favicon::class( implode( $__dirname, $path ) ) );

	// support gzip / deflate transfer-encoding
	// support gzip / deflate transfer-encoding
	$app->use( compression::class() );

	// application/json
	// application/json
	$app->use( express::json( [
				'limit' => $parsoidConfig->maxFormSize
			]
		)
	);

	// application/x-www-form-urlencoded
	// multipart/form-data
	// application/x-www-form-urlencoded
	// multipart/form-data
	$app->use( busboy::class( [
				'limits' => [
					'fields' => 10,
					'fieldSize' => $parsoidConfig->maxFormSize
				]
			]
		)
	);
	$app->use( function ( $req, $res, $next ) {
			$req->body = $req->body || [];
			if ( !$req->busboy ) {
				return $next();
			}
			$req->busboy->on( 'field', function ( $field, $val ) use ( &$req ) {
					$req->body[ $field ] = $val;
			}
			);
			$req->busboy->on( 'finish', function () use ( &$next ) {
					$next();
			}
			);
			$req->pipe( $req->busboy );
	}
	);

	// Allow cross-domain requests (CORS) so that parsoid service can be used
	// by third-party sites.
	// Allow cross-domain requests (CORS) so that parsoid service can be used
	// by third-party sites.
	if ( $parsoidConfig->allowCORS ) {
		$app->use( function ( $req, $res, $next ) use ( &$parsoidConfig ) {
				$res->set( 'Access-Control-Allow-Origin', $parsoidConfig->allowCORS );
				$next();
		}
		);
	}

	// just a timer
	// just a timer
	$app->use( function ( $req, $res, $next ) use ( &$JSUtils ) {
			$res->locals->start = JSUtils::startTime();
			$next();
	}
	);

	// Log unhandleds errors passed along with our logger.
	// Log unhandleds errors passed along with our logger.
	$logError = function ( $err, $req, $res ) use ( &$processLogger ) {
		$logger = ( $res->locals->env ) ? $res->locals->env->logger : $processLogger;
		$args = [ 'warn', $req->method, $req->originalUrl, $err ];
		if ( $err->type === 'entity.too.large' ) {
			// Add the expected length of the stream.
			$args[] = 'expected: ' . $err->expected;
		}
		call_user_func_array( [ $logger, 'log' ], $args );
	};

	$app->use( function ( $err, $req, $res, $next ) use ( &$finalHandler, &$logError ) {
			$done = finalHandler::class( $req, $res, [ 'onerror' => $logError ] );
			$done( $err );
	}
	);

	// Count http error codes
	// Count http error codes
	$app->use( function ( $req, $res, $next ) use ( &$parsoidConfig ) {
			$metrics = $parsoidConfig->metrics;
			if ( $metrics ) {
				$send = null;
				$clear = function () use ( &$res, &$send, &$clear ) {
					$res->removeListener( 'finish', $send );
					$res->removeListener( 'close', $clear );
					$res->removeListener( 'error', $clear );
				};
				$send = function () use ( &$res, &$metrics, &$clear ) {
					$code = String( $res->statusCode || 'unknown' );
					if ( $code !== '200' ) {
						$metrics->increment( 'http.status.' . $code );
					}
					$clear();
				};
				$res->once( 'finish', $send );
				$res->once( 'close', $clear );
				$res->once( 'error', $clear );
			}
			$next();
	}
	);

	// Routes
	// Routes

	$routes = require './routes' ( $parsoidConfig, $processLogger, $parsoidOptions, $parse );

	$a = $routes->acceptable;
	$p = $routes->parserEnvMw;
	$u = $routes->updateActiveRequests;
	$v3 = $routes->v3Middle;

	$app->get( '/', $routes->home );
	$app->get( '/robots.txt', $routes->robots );
	$app->get( '/version', $routes->version );
	$app->get( '/_version', $routes->version ); // for backwards compat.

	// v3 API routes
	// for backwards compat.

	// v3 API routes
	$app->get( '/:domain/v3/page/:format/:title/:revision?', $v3, $u, $p, $a, $routes->v3Get );
	$app->post( '/:domain/v3/transform/:from/to/:format/:title?/:revision?', $v3, $u, $p, $a, $routes->v3Post );

	// private routes
	// private routes
	if ( $parsoidConfig->devAPI ) {
		$internal = require './internal' ( $parsoidConfig, $processLogger );
		$i = $internal->middle;
		$app->get( '/_html/:prefix?/:title?', $i, $p, $internal->html2wtForm );
		$app->get( '/_wikitext/:prefix?/:title?', $i, $p, $internal->wt2htmlForm );
		$app->get( '/_rt/:prefix?/:title?', $i, $p, $internal->roundtripTesting );
		$app->get( '/_rtve/:prefix?/:title?', $i, $p, $internal->roundtripTestingNL );
		$app->get( '/_rtselser/:prefix?/:title?', $i, $p, $internal->roundtripSelser );
		$app->get( '/_rtform/:prefix?/:title?', $i, $p, $internal->getRtForm );
		$app->post( '/_rtform/:prefix?/:title?', $i, $p, $internal->postRtForm );
	}

	$server = null;
	/* await */ new Promise( function ( $resolve, $reject ) use ( &$app, &$processLogger, &$port, &$host ) {
			$app->on( 'error', function ( $err ) use ( &$processLogger, &$reject ) {
					$processLogger->log( 'error', $err );
					$reject( $err );
			}
			);
			$server = $app->listen( $port, $host, $resolve );
	}
	);
	$port = $server->address()->port;
	$processLogger->log( 'info', "ready on {$host || ''}:{$port}" );
	return [
		'close' => /* async */function () use ( &$Promise, &$server, &$parsoidConfig, &$workerFarm, &$workers ) {
			try {
				/* await */ Promise::promisify( $server->close, false, $server )();
			} finally {
				if ( $parsoidConfig->useWorker ) { workerFarm::end( $workers );
	   }
				// The conf cache is reused across requests, but shouldn't
				// be shared between services.  This conflict arises when
				// service-runner num_workers is zero, and mocha spawns
				// services in succession.
				// The conf cache is reused across requests, but shouldn't
				// be shared between services.  This conflict arises when
				// service-runner num_workers is zero, and mocha spawns
				// services in succession.
				require '../config/MWParserEnvironment.js'::MWParserEnvironment::resetConfCache();
			}
		}

		,
		'port' => $port
	];
};
