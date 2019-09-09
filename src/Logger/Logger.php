<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module */

namespace Parsoid;



$LogData = require( './LogData.js' )::LogData;
$Promise = require( '../utils/promise.js' );
$JSUtils = require( '../utils/jsutils.js' )::JSUtils;

/**
 * Multi-purpose logger. Supports different kinds of logging (errors,
 * warnings, fatal errors, etc.) and a variety of logging data (errors,
 * strings, objects).
 *
 * @class
 * @param {Object} [opts] Logger options (not used by superclass).
 */
$Logger = function ( $opts ) {
	if ( !$opts ) { $opts = [];  }

	$this->_opts = $opts;
	$this->_logRequestQueue = [];
	$this->_backends = new Map();

	// Set up regular expressions so that logTypes can be registered with
	// backends, and so that logData can be routed to the right backends.
	// Default: matches empty string only
	$this->_testAllRE = new RegExp( /* RegExp */ '/^$/' );

	$this->_samplers = [];
	$this->_samplersRE = new RegExp( /* RegExp */ '/^$/' );
	$this->_samplersCache = new Map();
};

Logger::prototype::_createLogData = function ( $logType, $logObject ) use ( &$LogData ) {
	return new LogData( $logType, $logObject );
};

/**
 * Outputs logging and tracing information to different backends.
 * @param {string} logType
 * @return {undefined|Promise} a {@link Promise} that will be fulfilled when all
 *  logging is complete; for efficiency `undefined` is returned if this
 *  `logType` is being ignored (the common case).
 */
Logger::prototype::log = function ( $logType ) use ( &$Promise ) {
	try {
		// Potentially return early if we're sampling this log type.
		if ( preg_match( $this->_samplersRE, $logType )
&&				!preg_match( '/^fatal/', $logType )// No sampling for fatals.
		) {
			if ( !$this->_samplersCache->has( $logType ) ) {
				$i = 0;
				$len = count( $this->_samplers );
				for ( ;  $i < $len;  $i++ ) {
					$sample = $this->_samplers[ $i ];
					if ( preg_match( $sample->logTypeRE, $logType ) ) {
						$this->_samplersCache->set( $logType, $sample->percent );
						break; // Use the first applicable rate.
					}
				}
				Assert::invariant( $i < $len,
					"Odd, couldn't find the sample rate for: " . $logType
				);
			}
			// This works because it's [0, 100)
			if ( ( rand() * 100 ) >= $this->_samplersCache->get( $logType ) ) {
				return;
			}
		}

		// XXX this should be configurable.
		// Tests whether logType matches any of the applicable logTypes
		if ( preg_match( $this->_testAllRE, $logType ) ) {
			$logObject = array_slice( $arguments, 1 );
			$logData = $this->_createLogData( $logType, $logObject );
			// If we are already processing a log request, but a log was generated
			// while processing the first request, processingLogRequest will be true.
			// We ignore all follow-on log events unless they are fatal. We put all
			// fatal log events on the logRequestQueue for processing later on.
			if ( $this->processingLogRequest ) {
				if ( preg_match( '/^fatal$/D', $logType ) ) {
					// Array.from converts arguments to a real array
					// So that arguments can later be used in log.apply
					$this->_logRequestQueue[] = Array::from( $arguments );
					// Create a deferred, which will be resolved when this
					// data is finally logged.
					$d = Promise::defer();
					$this->_logRequestQueue[] = $d;
					return $d->promise;
				}
				return; // ignored
			} else {
				// We weren't already processing a request, so processingLogRequest flag
				// is set to true. Then we send the logData to appropriate backends and
				// process any fatal log events that we find on the queue.
				$this->processingLogRequest = true;
				// Callback to routeToBackends forces logging of fatal log events.
				$p = $this->_routeToBackends( $logData );
				$this->processingLogRequest = false;
				if ( count( $this->_logRequestQueue ) > 0 ) {
					$args = array_pop( $this->_logRequestQueue );
					$dd = array_pop( $this->_logRequestQueue );
					call_user_func_array( [ $this, 'log' ], $args )->then( $dd->resolve, $dd->reject );
				}
				return $p; // could be undefined, if no backends handled this
			}
		}
	} catch ( Exception $e ) {
		$console->log( $e->message );
		$console->log( $e->stack );
	}
	return; // nothing handled this log type
};

/**
 * Convert logType into a source string for a regExp that we can
 * subsequently use to test logTypes passed in from Logger.log.
 * @param {RegExp} logType
 * @return {string}
 * @private
 */
function logTypeToString( $logType ) {
	global $JSUtils;
	$logTypeString = null;
	if ( $logType instanceof $RegExp ) {
		$logTypeString = $logType->source;
	} elseif ( gettype( $logType ) === 'string' ) {
		$logTypeString = '^' . JSUtils::escapeRegExp( $logType ) . '$';
	} else {
		throw new Error( 'logType is neither a regular expression nor a string.' );
	}
	return $logTypeString;
}

/**
 * Logger backend.
 * @callback module:logger/Logger~backendCallback
 * @param {LogData} logData The data to log.
 * @return {Promise} A {@link Promise} that is fulfilled when logging of this
 *  `logData` is complete.
 */

/**
 * Registers a backend by adding it to the collection of backends.
 * @param {RegExp} logType
 * @param {backendCallback} backend Backend to send logging / tracing info to.
 */
Logger::prototype::registerBackend = function ( $logType, $backend ) {
	$backendArray = [];
	$logTypeString = logTypeToString( $logType );

	// If we've already started an array of backends for this logType,
	// add this backend to the array; otherwise, start a new array
	// consisting of this backend.
	if ( $this->_backends->has( $logTypeString ) ) {
		$backendArray = $this->_backends->get( $logTypeString );
	}
	if ( array_search( $backend, $backendArray ) === -1 ) {
		$backendArray[] = $backend;
	}
	$this->_backends->set( $logTypeString, $backendArray );

	// Update the global test RE
	$this->_testAllRE = new RegExp( $this->_testAllRE->source . '|' . $logTypeString );
};

/**
 * Register sampling rates, in percent, for log types.
 * @param {RegExp} logType
 * @param {number} percent
 */
Logger::prototype::registerSampling = function ( $logType, $percent ) {
	$logTypeString = logTypeToString( $logType );
	$percent = Number( $percent );
	if ( Number::isNaN( $percent ) || $percent < 0 || $percent > 100 ) {
		throw new Error( 'Sampling rate for ' . $logType
.				' is not a percentage: ' . $percent
		);
	}
	$this->_samplers[] = [ 'logTypeRE' => new RegExp( $logTypeString ), 'percent' => $percent ];
	$this->_samplersRE = new RegExp( $this->_samplersRE->source . '|' . $logTypeString );
};

/** @return {backendCallback} */
Logger::prototype::getDefaultBackend = function () {
	return function ( $logData ) {return  $this->_defaultBackend( $logData ); };
};

/** @return {backendCallback} */
Logger::prototype::getDefaultTracerBackend = function () {
	return function ( $logData ) {return  $this->_defaultTracerBackend( $logData ); };
};

/**
 * Optional default backend.
 * @method
 * @param {LogData} logData
 * @return {Promise} Promise which is fulfilled when logging is complete.
 */
Logger::prototype::_defaultBackend = /* async */function ( $logData ) { // eslint-disable-line require-yield
	// Wrap in try-catch-finally so we can more accurately
	// pin backend crashers on specific logging backends.
	try {
		$console->warn( '[' . $logData->logType . '] ' . $logData->fullMsg() );
	} catch ( Exception $e ) {
		$console->error( 'Error in Logger._defaultBackend: ' . $e );
	}
}







;

/**
 * Optional default tracing and debugging backend.
 * @method
 * @param {LogData} logData
 * @return {Promise} Promise which is fulfilled when logging is complete.
 */
Logger::prototype::_defaultTracerBackend = /* async */function ( $logData ) { // eslint-disable-line require-yield
	try {
		$logType = $logData->logType;

		// indent by number of slashes
		// indent by number of slashes
		$indent = '  '->repeat( count( preg_match_all( '/\//', $logType, $FIXME ) ) - 1 );
		// XXX: could shorten or strip trace/ logType prefix in a pure trace logger
		// XXX: could shorten or strip trace/ logType prefix in a pure trace logger
		$msg = $indent + $logType;

		// Fixed-width type column so that the messages align
		// Fixed-width type column so that the messages align
		$typeColumnWidth = 30;
		$msg = substr( $msg, 0, $typeColumnWidth );
		$msg += ' '->repeat( $typeColumnWidth - count( $msg ) );
		$msg += '| ' . $indent . $logData->msg();

		if ( $msg ) {
			$console->warn( $msg );
		}
	} catch ( Exception $e ) {
		$console->error( 'Error in Logger._defaultTracerBackend: ' . $e );
	}
}




















;

/**
 * Gets all registered backends that apply to a particular logType.
 * @param {LogData} logData
 * @return {Generator.<backendCallback>}
 */
Logger::prototype::_getApplicableBackends = function ( $logData ) {
	$logType = $logData->logType;
	$backendsMap = $this->_backends;
	$logTypeString = null;
	foreach ( $backendsMap->keys() as $logTypeString => $___ ) {
		// Convert the stored logTypeString back into a regExp, in case
		// it applies to multiple logTypes (e.g. /fatal|error/).
		if ( preg_match( new RegExp( $logTypeString ), $logType ) ) {
			/* await */ $backendsMap->get( $logTypeString );
		}
	}
};

/**
 * Routes log data to backends. If `logData.logType` is fatal, exits process
 * after logging to all backends.
 * @param {LogData} logData
 * @return {Promise|undefined} A {@link Promise} that is fulfilled when all
 *   logging is complete, or `undefined` if no backend was applicable and
 *   the `logType` was not fatal (fast path common case).
 */
Logger::prototype::_routeToBackends = function ( $logData ) use ( &$Promise ) {
	$applicableBackends = Array::from( $this->_getApplicableBackends( $logData ) );
	$noop = function () {};
	// fast path!
	if ( count( $applicableBackends ) === 0 && !preg_match( '/^fatal$/D', $logData->logType ) ) {
		return; // no promise allocated on fast path.
	}
	// If the logType is fatal, exits the process after logging
	// to all of the backends.
	// Additionally runs a callback that looks for fatal
	// events in the queue and logs them.
	return Promise::all( array_map( $applicableBackends, function ( $backend ) {
				$d = Promise::defer();
				$p = $d->promise;
				$r = null;
				try {
					// For backward-compatibility, pass in a callback as the 2nd arg
					// (it should be ignored by current backends)
					$r = $backend( $logData, $d->resolve );
				} catch ( Exception $e ) {

					// ignore any exceptions thrown while calling 'backend'

					// Backends *should* return a Promise... but for backward-compatibility
					// don't fret if they don't.
				}// ignore any exceptions thrown while calling 'backend'

				// Backends *should* return a Promise... but for backward-compatibility
				// don't fret if they don't.
				if ( $r && gettype( $r ) === 'object' && $r->then ) {
					$p = Promise::race( [ $p, $r ] );
				}
				// The returned promise should always resolve, never reject.
				// The returned promise should always resolve, never reject.
				return $p->catch( $noop );
			}
		)

















	)->finally( function () {
			if ( preg_match( '/^fatal$/D', $logData->logType ) ) {
				// Give some time for async loggers to deliver the message
				setTimeout( function () { $process->exit( 1 );  }, 100 );
			}
		}
	);
};

if ( gettype( $module ) === 'object' ) {
	$module->exports->Logger = $Logger;
}
