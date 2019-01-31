<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module */

namespace Parsoid;

use Parsoid\coreutil as coreutil;
$JSUtils = require( '../utils/jsutils.js' )::JSUtils;
$Logger = require( './Logger.js' )::Logger;
$LogData = require( './LogData.js' )::LogData;
$Promise = require( '../utils/promise.js' );


/**
 * @class
 */
function LocationData( $wiki, $title, $meta, $reqId, $userAgent ) {
	$this->wiki = $wiki;
	$this->title = $title;
	$this->oldId = ( $meta && $meta->revision && $meta->revision->revid ) ?
	$meta->revision->revid : null;
	$this->reqId = $reqId || null;
	$this->userAgent = $userAgent || null;
}
LocationData::prototype::toString = function () {
	$query = ( $this->oldId ) ? '?oldid=' . $this->oldId : '';
	return "[{$this->wiki}/{$this->title}{$query}]";
};


/**
 * @class
 * @extends module:logger/LogData~LogData
 */
function ParsoidLogData( $logType, $logObject, $locationData ) {
	$this->locationData = $locationData;
	call_user_func( 'LogData', $logType, $logObject );
}
coreutil::inherits( $ParsoidLogData, $LogData );


/**
 * @class
 * @extends module:logger/Logger~Logger
 * @param {MWParserEnvironment} env
 */
function ParsoidLogger( $env ) {
	$this->env = $env;
	call_user_func_array( 'Logger', [] );
}
coreutil::inherits( $ParsoidLogger, $Logger );

ParsoidLogger::prototype::getDefaultBackend = function () {
	return function ( $logData ) {return  $this->_defaultBackend( $logData ); };
};

ParsoidLogger::prototype::getDefaultTracerBackend = function () {
	return function ( $logData ) {return  $this->_defaultTracerBackend( $logData ); };
};

ParsoidLogger::prototype::registerLoggingBackends = function ( $defaultLogLevels, $parsoidConfig, $lintLogger ) use ( &$JSUtils ) {
	// Register a default backend based on default logTypes.
	// DEFAULT: Combine all regexp-escaped default logTypes into a single regexp.
	$fixLogType = function ( $logType ) use ( &$JSUtils ) { return JSUtils::escapeRegExp( $logType ) . '(\/|$)';  };
	$defaultRE = new RegExp( implode( '|', array_map( ( $defaultLogLevels || [] ), $fixLogType ) ) );
	$loggerBackend = null;
	if ( gettype( $parsoidConfig->loggerBackend ) === 'function' ) {
		$loggerBackend = $parsoidConfig->loggerBackend;
	} elseif ( $parsoidConfig->loggerBackend && $parsoidConfig->loggerBackend->name ) {
		$parts = explode( '/', $parsoidConfig->loggerBackend->name );
		// use a leading colon to indicate a parsoid-local logger.
		$ClassObj = require( preg_replace( '/^:/', './', array_shift( $parts ), 1 ) );
		$parts->forEach( function ( $k ) {
				$ClassObj = ClassObj[ $k ];
			}
		);
		$loggerBackend = new ClassObj( $parsoidConfig->loggerBackend->options )->
		getLogger();
	} else {
		$loggerBackend = $this->getDefaultBackend();
	}
	$this->registerBackend( $defaultRE, $loggerBackend );

	// Register sampling
	if ( is_array( $parsoidConfig->loggerSampling ) ) {
		$parsoidConfig->loggerSampling->forEach( function ( $s ) {
				$this->registerSampling( $s[ 0 ], $s[ 1 ] );
			}, $this
		);
	}

	// TRACE / DEBUG: Make trace / debug regexp with appropriate postfixes,
	// depending on the command-line options passed in.
	function buildTraceOrDebugFlag( $parsoidFlags, $logType ) {
		$escapedFlags = array_map( Array::from( $parsoidFlags ), JSUtils::escapeRegExp );
		$combinedFlag = $logType . '/(' . implode( '|', $escapedFlags ) . ')(\/|$)';
		return new RegExp( $combinedFlag );
	}

	// Register separate backend for tracing / debugging events.
	// Tracing and debugging use the same backend for now.
	$tracerBackend = ( gettype( $parsoidConfig->tracerBackend ) === 'function' ) ?
	$parsoidConfig->tracerBackend : $this->getDefaultTracerBackend();
	if ( $parsoidConfig->traceFlags ) {
		$this->registerBackend( buildTraceOrDebugFlag( $parsoidConfig->traceFlags, 'trace' ),
			$tracerBackend
		);
	}
	if ( $parsoidConfig->debug ) {
		$this->registerBackend( /* RegExp */ '/^debug(\/.*)?/', $tracerBackend );
	} elseif ( $parsoidConfig->debugFlags ) {
		$this->registerBackend( buildTraceOrDebugFlag( $parsoidConfig->debugFlags, 'debug' ),
			$tracerBackend
		);
	}
	if ( $lintLogger && $parsoidConfig->linting ) {
		$this->registerBackend( /* RegExp */ '/^lint(\/.*)?/', function ( $logData ) use ( &$lintLogger ) {return  $lintLogger->linterBackend( $logData ); } );
		$this->registerBackend( /* RegExp */ '/^end(\/.*)/', function ( $logData ) use ( &$lintLogger ) {return  $lintLogger->logLintOutput( $logData ); } );
	}
};

ParsoidLogger::prototype::_createLogData = function ( $logType, $logObject ) {
	return new ParsoidLogData( $logType, $logObject, $this->locationData() );
};

// Set up a location message function in Logdata
// so all logging backends can output location message
ParsoidLogger::prototype::locationData = function () {
	return new LocationData(
		$this->env->conf->wiki->iwp,
		$this->env->page->name,
		$this->env->page->meta,
		$this->env->reqId,
		$this->env->userAgent
	);
};

ParsoidLogger::prototype::_defaultBackend = /* async */function ( $logData ) { // eslint-disable-line require-yield
	// The default logging backend provided by Logger.js is not useful to us.
	// Parsoid needs to be able to emit page location to logs.
	try {
		$console->warn( '[%s]%s %s', $logData->logType, $logData->locationData->toString(), $logData->fullMsg() );
	} catch ( Exception $e ) {
		$console->error( 'Error in ParsoidLogger._defaultBackend: %s', $e );
	}
}







;

$prettyLogTypeMap = [
	'debug' => '[DEBUG]',
	'trace/peg' => '[peg]',
	'trace/pre' => '[PRE]',
	'debug/pre' => '[PRE-DBG]',
	'trace/p-wrap' => '[P]',
	'trace/html' => '[HTML]',
	'debug/html' => '[HTML-DBG]',
	'trace/sanitizer' => '[SANITY]',
	'trace/tsp' => '[TSP]',
	'trace/dsr' => '[DSR]',
	'trace/list' => '[LIST]',
	'trace/quote' => '[QUOTE]',
	'trace/sync:1' => '[S1]',
	'trace/async:2' => '[A2]',
	'trace/sync:3' => '[S3]',
	'trace/wts' => '[WTS]',
	'debug/wts/sep' => '[SEP]',
	'trace/selser' => '[SELSER]',
	'trace/domdiff' => '[DOM-DIFF]',
	'trace/wt-escape' => '[wt-esc]',
	'trace/batcher' => '[batcher]',
	'trace/apirequest' => '[ApiRequest]'
];

ParsoidLogger::prototype::_defaultTracerBackend = /* async */function ( $logData ) use ( &$prettyLogTypeMap ) { // eslint-disable-line require-yield
	try {
		$msg = '';
		$typeColumnWidth = 15;
		$logType = $logData->logType;
		$firstArg = ( is_array( $logData->logObject ) ) ? $logData->logObject[ 0 ] : null;

		// Assume first numeric arg is always the pipeline id
		// Assume first numeric arg is always the pipeline id
		if ( gettype( $firstArg ) === 'number' ) {
			$msg = $firstArg . '-';
			array_shift( $logData->logObject );
		}

		// indent by number of slashes
		// indent by number of slashes
		$match = preg_match_all( '/\//', $logType, $FIXME );
		$level = ( $match ) ? count( $match ) - 1 : 0;
		$indent = '  '->repeat( $level );
		$msg += $indent;

		$prettyLogType = $prettyLogTypeMap[ $logType ];
		if ( $prettyLogType ) {
			$msg += $prettyLogType;
		} else {
			// XXX: could shorten or strip trace/ logType prefix in a pure
			// trace logger
			$msg += $logType;

			// More space for these log types
			// More space for these log types
			$typeColumnWidth = 30;
		}

		// Fixed-width type column so that the messages align
		// Fixed-width type column so that the messages align
		$msg = substr( $msg, 0, $typeColumnWidth );
		$msg += ' '->repeat( $typeColumnWidth - count( $msg ) );
		$msg += '| ' . $indent . $logData->msg();

		if ( $msg ) {
			$console->warn( $msg );
		}
	} catch ( Exception $e ) {
		$console->error( 'Error in ParsoidLogger._defaultTracerBackend: ' . $e );
	}
}









































;

if ( gettype( $module ) === 'object' ) {
	$module->exports->ParsoidLogger = $ParsoidLogger;
	$module->exports->ParsoidLogData = $ParsoidLogData;
}
