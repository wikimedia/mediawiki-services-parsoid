<?php // lint >= 99.9
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module */

namespace Parsoid;

/**
 * Consolidates logging data into a single flattened
 * object (flatLogObject) and exposes various methods
 * that can be used by backends to generate message
 * strings (e.g., stack trace).
 *
 * @class
 * @param {string} logType Type of log being generated.
 * @param {Object} logObject Data being logged.
 */
$LogData = function ( $logType, $logObject ) {
	$this->logType = $logType;
	$this->logObject = $logObject;
	$this->_error = new Error();

	// Cache log information if previously constructed.
	$this->_cache = [];
};

/**
 * Generate a full message string consisting of a message and stack trace.
 */
LogData::prototype::fullMsg = function () {
	if ( $this->_cache->fullMsg === null ) {
		$messageString = $this->msg();

		// Stack traces only for error & fatal
		// FIXME: This should be configurable later on.
		if ( preg_match( '/^(error|fatal)(\/|$)?/', $this->logType ) && $this->stack() ) {
			$messageString += "\n" . $this->stack();
		}

		$this->_cache->fullMsg = $messageString;
	}
	return $this->_cache->fullMsg;
};

/**
 * Generate a message string that combines all of the
 * logObject's message fields (if an originally an object)
 * or strings (if originally an array of strings).
 */
LogData::prototype::msg = function () {
	if ( $this->_cache->msg === null ) {
		$this->_cache->msg = $this->flatLogObject()->msg;
	}
	return $this->_cache->msg;
};

LogData::prototype::_getStack = function () {
	// Save original Error.prepareStackTrace
	$origPrepareStackTrace = Error::prepareStackTrace;

	// Override with function that just returns `stack`
	Error::prepareStackTrace = function ( $_, $s ) { return $s;
 };

	// Remove superfluous function calls on stack
	$stack = $this->_error->stack;
	for ( $i = 0;  $i < count( $stack ) - 1;  $i++ ) {
		if ( preg_match( '/\.log \(/', $stack[ $i ] ) ) {
			$stack = array_slice( $stack, $i + 1 );
			break;
		}
	}

	// Restore original `Error.prepareStackTrace`
	Error::prepareStackTrace = $origPrepareStackTrace;

	return "Stack:\n  " . implode( "\n  ", $stack );
};

/**
 * Generates a message string with a stack trace. Uses the
 * flattened logObject's stack trace if it exists; otherwise,
 * creates a new stack trace.
 */
LogData::prototype::stack = function () {
	if ( $this->_cache->stack === null ) {
		$this->_cache->stack = ( $this->flatLogObject()->stack === null ) ?
		$this->_getStack() : $this->flatLogObject()->stack;
	}
	return $this->_cache->stack;
};

/**
 * Flattens the logObject array into a single object for access
 * by backends.
 */
LogData::prototype::flatLogObject = function () {
	if ( $this->_cache->flatLogObject === null ) {
		$this->_cache->flatLogObject = $this->_flatten( $this->logObject, 'top level' );
	}
	return $this->_cache->flatLogObject;
};

/**
 * Returns a flattened object with an arbitrary number of fields,
 * including "msg" (combining all "msg" fields and strings from
 * underlying objects) and "stack" (a stack trace, if any).
 *
 * @param {Object} o Object to flatten.
 * @param {string} topLevel Separate top-level from recursive calls.
 * @return {Object} Flattened Object.
 * @return {string} [return.msg] All "msg" fields, combined with spaces.
 * @return {string} [return.longMsg] All "msg" fields, combined with newlines.
 * @return {string} [return.stack] A stack trace (if any).
 */
LogData::prototype::_flatten = function ( $o, $topLevel ) {
	$f = null;
$msg = null;
$longMsg = null;

	if ( gettype( $o ) === null || $o === null ) {
		return [ 'msg' => '' ];
	} elseif ( is_array( $o ) && $topLevel ) {
		// flatten components, but no longer in a top-level context.
		$f = array_map( $o, function ( $oo ) {return $this->_flatten( $oo );
  } );
		// join all the messages with spaces or newlines between them.
		$tobool = ( function ( $x ) {return (bool)$x;
  } );
		$msg = implode( ' ', array_map( $f, function ( $oo ) {return $oo->msg;
  } )->filter( $tobool ) );
		$longMsg = implode( "\n", array_map( $f, function ( $oo ) {return $oo->msg;
  } )->filter( $tobool ) );
		// merge all custom fields
		$f = array_reduce( $f, function ( $prev, $oo ) {return Object::assign( $prev, $oo );
  }, [] );
		return Object::assign( $f, [
				'msg' => $msg,
				'longMsg' => $longMsg
			]
		);
	} elseif ( $o instanceof $Error ) {
		$f = [
			'msg' => $o->message,
			// In some cases, we wish to suppress stacks when logging,
			// as indicated by `suppressLoggingStack`.
			// (E.g. see DoesNotExistError in mediawikiApiRequest.js).
			// We return a defined value to avoid generating a stack above.
			'stack' => ( $o->suppressLoggingStack ) ? '' : $o->stack
		];
		if ( $o->httpStatus ) {
			$f->httpStatus = $o->httpStatus;
		}
		return $f;
	} elseif ( gettype( $o ) === 'function' ) {
		return $this->_flatten( $o() );
	} elseif ( gettype( $o ) === 'object' && $o->hasOwnProperty( 'msg' ) ) {
		return $o;
	} elseif ( gettype( $o ) === 'string' ) {
		return [ 'msg' => $o ];
	} else {
		return [ 'msg' => json_encode( $o ) ];
	}
};

if ( gettype( $module ) === 'object' ) {
	$module->exports->LogData = $LogData;
}
