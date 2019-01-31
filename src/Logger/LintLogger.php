<?php // lint >= 99.9
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module */
/**
 * Logger backend for linter.
 * This backend filters out logging messages with Logtype "lint/*" and
 * logs them (console, external service).
 */

namespace Parsoid;

$LintRequest = require '../mw/ApiRequest.js'::LintRequest;
$Promise = require '../utils/promise.js';

/**
 * @class
 */
$LintLogger = function ( $env ) {
	$this->_env = $env;
	$this->buffer = [];
};

LintLogger::prototype::_lintError = function () {
	$env = $this->_env;
	$args = $arguments;
	// Call this async since recursive sync calls to the logger are suppressed
	$process->nextTick( function () {
			call_user_func_array( [ $env, 'log' ], $args );
	}
	);
};

/**
 * @method
 * @param {LogData} logData
 * @return {Promise}
 */
LintLogger::prototype::logLintOutput = /* async */function ( $logData ) use ( &$LintRequest ) {
	$env = $this->_env;
	$enabledBuffer = null;
	try {
		if ( $env->conf->parsoid->linting === true ) {
			$enabledBuffer = $this->buffer; // Everything is enabled
		} else { // Everything is enabled
		if ( is_array( $env->conf->parsoid->linting ) ) {
			$enabledBuffer = $this->buffer->filter( function ( $item ) {
					return array_search( $item->type, $env->conf->parsoid->linting ) !== -1;
			}
			);
		} else {
			Assert::invariant( false, 'Why are we here? Linting is disabled.' );
		}
		}

		$this->buffer = [];

		if ( $env->page->id % $env->conf->parsoid->linter->apiSampling !== 0 ) {
			return;
		}

		// Skip linting if we cannot lint it
		// Skip linting if we cannot lint it
		if ( !$env->page->hasLintableContentModel() ) {
			return;
		}

		if ( !$env->conf->parsoid->linter->sendAPI ) {
			$enabledBuffer->forEach( function ( $item ) use ( &$env ) {
					// Call this async, since recursive sync calls to the logger
					// are suppressed.  This messes up the ordering, as you'd
					// expect, but since it's only for debugging it should be
					// acceptable.
					$process->nextTick( function () use ( &$env, &$item ) {
							$env->log( 'warn/lint/' . $item->type, $item );
					}
					);
			}
			);
			return;
		}

		if ( !$env->conf->wiki->linterEnabled ) {
			// If it's not installed, we can't send a request,
			// so skip.
			return;
		}

		if ( !$env->pageWithOldid ) {
			// We only want to send to the MW API if this was a request to
			// parse the full page.
			return;
		}

		// Only send the request if it the latest revision
		// Only send the request if it the latest revision
		if ( $env->page->meta->revision->revid === $env->page->latest ) {
			try {
				$data = /* await */ LintRequest::promise( $env, json_encode( $enabledBuffer ) );
				if ( $data->error ) { $env->log( 'error/lint/api', $data->error );
	   }
			} catch ( Exception $ee ) {
				$env->log( 'error/lint/api', $ee );
			}
		}
	} catch ( Exception $e ) {
		$this->_lintError( 'error/lint/api', 'Error in logLintOutput: ', $e );
	}
};

/**
 * @method
 * @param {LogData} logData
 * @return {Promise}
 */
LintLogger::prototype::linterBackend = /* async */function ( $logData ) { // eslint-disable-line require-yield
	// Wrap in try-catch-finally so we can more accurately
	// pin errors to specific logging backends
	try {
		$lintObj = $logData->logObject[ 0 ];

		$msg = [
			'type' => preg_match( '/lint\/(.*)/', $logData->logType )[ 1 ],
			'params' => $lintObj->params || []
		];

		$dsr = $lintObj->dsr;
		if ( $dsr ) {
			$msg->dsr = $dsr;
			if ( $lintObj->templateInfo ) {
				$msg->templateInfo = $lintObj->templateInfo;
			}

			$this->buffer[] = $msg;
		} else {
			$this->_lintError( 'error/lint', 'Missing DSR; msg=', $msg );
		}
	} catch ( Exception $e ) {
		$this->_lintError( 'error/lint', 'Error in linterBackend: ', $e );
	}
};

if ( gettype( $module ) === 'object' ) {
	$module->exports->LintLogger = $LintLogger;
}
