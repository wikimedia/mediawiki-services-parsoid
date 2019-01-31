<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * Some parser functions, and quite a bunch of stubs of parser functions.
 *
 * IMPORTANT NOTE: These parser functions are only used by the Parsoid-native
 * template expansion pipeline, which is *not* the default or used in
 * production. Normally we use API calls into a MediaWiki installation to
 * implement parser functions and other preprocessor functionality. The only
 * use of this code is currently in parserTests, but those tests should
 * probably be marked as PHP-only and any mixed testing moved into separate
 * tests. This means that there is not much point in spending time on
 * implementing more parser functions here.
 *
 * There are still quite a few missing, see
 * {@link http://www.mediawiki.org/wiki/Help:Magic_words} and
 * {@link http://www.mediawiki.org/wiki/Help:Extension:ParserFunctions}.
 * Instantiated and called by the {@link TemplateHandler} extension.
 * Any `pf_<prefix>`
 * matching a lower-cased template name prefix up to the first colon will
 * override that template.
 * @module
 */

namespace Parsoid;

use Parsoid\Promise as Promise;

$Sanitizer = require './Sanitizer.js'::Sanitizer;
$TokenUtils = require '../../utils/TokenUtils.js'::TokenUtils;
$Util = require '../../utils/Util.js'::Util;
$temp0 = require '../../tokens/TokenTypes.js';
$KV = $temp0::KV;
$TagTk = $temp0::TagTk;
$EndTagTk = $temp0::EndTagTk;
$SelfclosingTagTk = $temp0::SelfclosingTagTk;

/**
 * @class
 * @param {MWParserEnvironment} env
 */
function ParserFunctions( $env ) {
	$this->env = $env;
}

// 'cb' can only be called once after "everything" is done.
// But, we need something that can be used in async context where it is
// called repeatedly till we are done.
//
// Primarily needed in the context of async.map calls that requires a 1-shot callback.
//
// Use with caution!  If the async stream that we are accumulating into the buffer
// is a firehose of tokens, the buffer will become huge.
function buildAsyncOutputBufferCB( $cb ) {
	function AsyncOutputBufferCB( $cb2 ) {
		$this->accum = [];
		$this->targetCB = $cb2;
	}

	AsyncOutputBufferCB::prototype::processAsyncOutput = function ( $res ) {
		// * Ignore switch-to-async mode calls since
		// we are actually collapsing async calls.
		// * Accumulate async call results in an array
		// till we get the signal that we are all done
		// * Once we are done, pass everything to the target cb.
		if ( $res->async !== true ) {
			// There are 3 kinds of callbacks:
			// 1. cb({tokens: .. })
			// 2. cb({}) ==> toks can be undefined
			// 3. cb(foo) -- which means in some cases foo can
			// be one of the two cases above, or it can also be a simple string.
			//
			// Version 1. is the general case.
			// Versions 2. and 3. are optimized scenarios to eliminate
			// additional processing of tokens.
			//
			// In the C++ version, this is handled more cleanly.
			$toks = $res->tokens;
			if ( !$toks && $res->constructor === $String ) {
				$toks = $res;
			}

			if ( $toks ) {
				if ( is_array( $toks ) ) {
					for ( $i = 0,  $l = count( $toks );  $i < $l;  $i++ ) {
						$this->accum[] = $toks[ $i ];
					}
					// this.accum = this.accum.concat(toks);
				} else {
					$this->accum[] = $toks;
				}
			}

			if ( !$res->async ) {
				// we are done!
				$this->targetCB( $this->accum );
			}
		}
	};

	$r = new AsyncOutputBufferCB( $cb );
	return $r->processAsyncOutput->bind( $r );
}

// Temporary helper.
ParserFunctions::prototype::_rejoinKV = function ( $trim, $k, $v ) use ( &$TokenUtils ) {
	if ( $k->constructor === $String && count( $k ) > 0 ) {
		return [ $k ]->concat( [ '=' ], $v );
	} elseif ( is_array( $k ) && count( $k ) > 0 ) {
		return $k->concat( [ '=' ], $v );
	} else {
		return ( $trim ) ? ( ( $v->constructor === $String ) ? trim( $v ) : TokenUtils::tokenTrim( $v ) ) : $v;
	}
};

// XXX: move to frame?
ParserFunctions::prototype::expandKV = function ( $kv, $cb, $defaultValue, $type, $trim ) {
	if ( $trim === null ) {
		$trim = true;
	}

	if ( $type === null ) {
		$type = 'tokens/x-mediawiki/expanded';
	}
	if ( $kv === null ) {
		$cb( [ 'tokens' => [ $defaultValue || '' ] ] );
	} elseif ( $kv->constructor === $String ) {
		return $cb( [ 'tokens' => [ $kv ] ] );
	} elseif ( $kv->k->constructor === $String && $kv->v->constructor === $String ) {
		if ( $kv->k ) {
			$cb( [ 'tokens' => [ $kv->k . '=' . $kv->v ] ] );
		} else {
			$cb( [ 'tokens' => [ ( $trim ) ? trim( $kv->v ) : $kv->v ] ] );
		}
	} else {
		$getCB = function ( $v ) use ( &$cb, &$trim, &$kv ) {
			$cb( [ 'tokens' => $this->_rejoinKV( $trim, $kv->k, $v ) ] );
		};
		$kv->v->get( [
				'type' => $type,
				'cb' => $getCB,
				'asyncCB' => $cb
			]
		);
	}
};

ParserFunctions::prototype::pf_if = function ( $token, $frame, $cb, $args ) {
	$target = $args[ 0 ]->k;
	if ( trim( $target ) !== '' ) {
		$this->expandKV( $args[ 1 ], $cb );
	} else {
		$this->expandKV( $args[ 2 ], $cb );
	}
};

ParserFunctions::prototype::_switchLookupFallback = function ( $frame, $kvs, $key, $dict, $cb, $v ) use ( &$TokenUtils ) {
	$kv = null;
	$l = count( $kvs );
	$this->env->log( 'debug', '_switchLookupFallback', count( $this->env ), $key, $v );
	$_cbTrim = function ( $res ) use ( &$cb, &$TokenUtils ) {
		if ( $res->constructor === $String ) {
			$cb( [ 'tokens' => [ trim( $res ) ], 'async' => $res->async ] );
		} elseif ( is_array( $res ) ) {
			$cb( [ 'tokens' => TokenUtils::tokenTrim( $res ), 'async' => $res->async ] );
		} else {
			$cb( $res );
		}
	};
	$_cbNoTrim = function ( $res ) use ( &$cb ) {
		if ( $res->constructor === $String ) {
			$cb( [ 'tokens' => [ $res ], 'async' => $res->async ] );
		} elseif ( is_array( $res ) ) {
			$cb( [ 'tokens' => $res, 'async' => $res->async ] );
		} elseif ( $res->async ) {
			$cb( $res );
		} else {
			$this->env->log( 'error', 'Unprocessable res in ParserFunctions:_cbNoTrim', $res );
		}
	};

	// 'v' need not be a string in cases where it is the last fall-through case
	$vStr = ( $v ) ? ( ( $v->constructor === $String ) ? $v : TokenUtils::tokensToString( $v ) ) : null;
	if ( $vStr && $key === trim( $vStr ) ) {
		// This handles fall-through switch cases:
		//
		// {{#switch:<key>
		// | c1 | c2 | c3 = <res>
		// ...
		// }}
		//
		// So if <key> matched c1, we want to return <res>.
		// Hence, we are looking for the next entry with a non-empty key.
		$this->env->log( 'debug', 'switch found' );
		for ( $j = 0;  $j < $l;  $j++ ) {
			$kv = $kvs[ $j ];
			// XXX: make sure the key is always one of these!
			if ( count( $kv->k ) ) {
				$kv->v->get( [
						'type' => 'tokens/x-mediawiki/expanded',
						'cb' => $_cbTrim,
						'asyncCB' => $_cbTrim
					]
				);
				return;
			}
		}
		// No value found, return empty string? XXX: check this
		$cb( [] );
	} elseif ( count( $kvs ) ) {
		// search for value-only entry which matches
		$i = 0;
		if ( $v ) {
			$i = 1;
		}
		for ( ;  $i < $l;  $i++ ) {
			$kv = $kvs[ $i ];
			if ( count( $kv->k ) || !count( $kv->v ) ) {
				// skip entries with keys or empty values
				continue;
			} else {
				if ( !$kv->v->get ) {
					$this->env->log( 'debug', $kv->v );
				}
				// We found a value-only entry.  However, we have to verify
				// if we have any fall-through cases that this matches.
				//
				// {{#switch:<key>
				// | c1 | c2 | c3 = <res>
				// ...
				// }}
				//
				// In the switch example above, if we found 'c1', that is
				// not the fallback value -- we have to check for fall-through
				// cases.  Hence the recursive callback to _switchLookupFallback.
				//
				// {{#switch:<key>
				// | c1 = <..>
				// | c2 = <..>
				// | [[Foo]]</div>
				// }}
				//
				// 'val' may be an array of tokens rather than a string as in the
				// example above where 'val' is indeed the final return value.
				// Hence 'tokens/x-mediawiki/expanded' type below.
				$kv->v->get( [
						'type' => 'tokens/x-mediawiki/expanded',
						'cb' => function ( $k, $val ) use ( &$frame, &$kvs, &$key, &$dict, &$cb ) {
							setImmediate(
								$this->_switchLookupFallback->bind( $this, $frame,
									array_slice( $kvs, $k + 1 ), $key, $dict, $cb, $val
								)
							);
						}->bind( $this, $i ),
						'asyncCB' => $cb
					]
				);
				return;
			}
		}
		// value not found!
		if ( isset( $dict[ '#default' ] ) ) {
			$dict[ '#default' ]->get( [
					'type' => 'tokens/x-mediawiki/expanded',
					'cb' => $_cbTrim,
					'asyncCB' => $cb
				]
			);
			return;
		} elseif ( count( $kvs ) ) {
			$lastKV = $kvs[ count( $kvs ) - 1 ];
			if ( $lastKV && !count( $lastKV->k ) ) {
				$lastKV->v->get( [
						'cb' => $_cbNoTrim,
						'asyncCB' => $cb
					]
				);
				return;
			} else {
				$cb( [] );
			}
		} else {
			// nothing found at all.
			$cb( [] );
		}
	} elseif ( $v ) {
		$cb( [ 'tokens' => ( is_array( $v ) ) ? $v : [ $v ] ] );
	} else {
		// nothing found at all.
		$cb( [] );
	}
};

// TODO: Implement
// http://www.mediawiki.org/wiki/Help:Extension:ParserFunctions#Grouping_results
ParserFunctions::prototype::pf_switch = function ( $token, $frame, $cb, $args ) use ( &$TokenUtils ) {
	$target = trim( $args[ 0 ]->k );
	$this->env->log( 'debug', 'switch enter', $target, $token );
	// create a dict from the remaining args
	array_shift( $args );
	$dict = $args->dict();
	if ( $target && $dict[ $target ] !== null ) {
		$this->env->log( 'debug', 'switch found: ', $target, $dict, ' res=', $dict[ $target ] );
		$dict[ $target ]->get( [
				'type' => 'tokens/x-mediawiki/expanded',
				'cb' => function ( $res ) use ( &$cb, &$TokenUtils ) {
					$cb( [ 'tokens' => ( $res->constructor === $String ) ? [ trim( $res ) ] : TokenUtils::tokenTrim( $res ) ] );
				},
				'asyncCB' => $cb
			]
		);
	} else {
		$this->_switchLookupFallback( $frame, $args, $target, $dict, $cb );
	}
};

// #ifeq
ParserFunctions::prototype::pf_ifeq = function ( $token, $frame, $cb, $args ) {
	if ( count( $args ) < 3 ) {
		$cb( [] );
	} else {
		$b = $args[ 1 ]->v;
		$b->get( [ 'cb' => $this->_ifeq_worker->bind( $this, $cb, $args ), 'asyncCB' => $cb ] );
	}
};

ParserFunctions::prototype::_ifeq_worker = function ( $cb, $args, $b ) {
	if ( trim( $args[ 0 ]->k ) === trim( $b ) ) {
		$this->expandKV( $args[ 2 ], $cb );
	} else {
		$this->expandKV( $args[ 3 ], $cb );
	}
};

ParserFunctions::prototype::pf_expr = function ( $token, $frame, $cb, $args ) {
	$res = null;
	$target = $args[ 0 ]->k;
	if ( $target ) {
		try {
			// FIXME: make this safe and implement MW expressions!
			$f = new function( 'return (' . $target . ')' ); // eslint-disable-line
			$res = $f();
		} catch ( Exception $e ) {
			$cb( [ 'tokens' => [ 'class="error" in expression ' . $target ] ] );
			return;
		}
	} else {
		$res = '';
	}
	// Avoid crashes
	if ( $res === null ) {
		$cb( [ 'tokens' => [ 'class="error" in expression ' . $target ] ] );
		return;
	}
	$cb( [ 'tokens' => [ $res->toString() ] ] );
};

ParserFunctions::prototype::pf_ifexpr = function ( $token, $frame, $cb, $args ) {
	$this->env->log( 'debug', '#ifexp: ', $args );
	$res = null;
	$target = $args[ 0 ]->k;
	if ( $target ) {
		try {
			// FIXME: make this safe, and fully implement MW expressions!
			$f = new function( 'return (' . $target . ')' ); // eslint-disable-line
			$res = $f();
		} catch ( Exception $e ) {
			$cb( [ 'tokens' => [ 'class="error" in expression ' . $target ] ] );
			return;
		}
	}
	if ( $res ) {
		$this->expandKV( $args[ 1 ], $cb );
	} else {
		$this->expandKV( $args[ 2 ], $cb );
	}
};

ParserFunctions::prototype::pf_iferror = function ( $token, $frame, $cb, $args ) {
	$target = $args[ 0 ]->k;
	if ( array_search( 'class="error"', $target ) >= 0 ) {
		$this->expandKV( $args[ 1 ], $cb );
	} else {
		$this->expandKV( $args[ 1 ], $cb, $target );
	}
};

ParserFunctions::prototype::pf_lc = function ( $token, $frame, $cb, $args ) {
	$cb( [ 'tokens' => [ strtolower( $args[ 0 ]->k ) ] ] );
};

ParserFunctions::prototype::pf_uc = function ( $token, $frame, $cb, $args ) {
	$cb( [ 'tokens' => [ strtoupper( $args[ 0 ]->k ) ] ] );
};

ParserFunctions::prototype::pf_ucfirst = function ( $token, $frame, $cb, $args ) {
	$target = $args[ 0 ]->k;
	if ( $target ) {
		$cb( [ 'tokens' => [ strtoupper( $target[ 0 ] ) + substr( $target, 1 ) ] ] );
	} else {
		$cb( [ 'tokens' => [] ] );
	}
};

ParserFunctions::prototype::pf_lcfirst = function ( $token, $frame, $cb, $args ) {
	$target = $args[ 0 ]->k;
	if ( $target ) {
		$cb( [ 'tokens' => [ strtolower( $target[ 0 ] ) + substr( $target, 1 ) ] ] );
	} else {
		$cb( [ 'tokens' => [] ] );
	}
};

ParserFunctions::prototype::pf_padleft = function ( $token, $frame, $cb, $params ) {
	$target = $params[ 0 ]->k;
	$env = $this->env;
	if ( !$params[ 1 ] ) {
		return $cb( [ 'tokens' => [] ] );
	}
	// expand parameters 1 and 2
	$params->getSlice( [
			'type' => 'text/x-mediawiki/expanded'
		], 1, 3
	)->then( function ( $args ) use ( &$target, &$cb, &$env ) {
			$n = +( $args[ 0 ]->v );
			if ( $n > 0 ) {
				$pad = '0';
				if ( $args[ 1 ] && $args[ 1 ]->v !== '' ) {
					$pad = $args[ 1 ]->v;
				}
				$padLength = count( $pad );
				$extra = '';
				while ( ( count( $target ) + strlen( $extra ) + $padLength ) < $n ) {
					$extra += $pad;
				}
				if ( count( $target ) + count( $extra ) < $n ) {
					$extra += substr( $pad, 0, $n - count( $target ) - count( $extra ) );
				}
				$cb( [ 'tokens' => [ $extra + $target ] ] );
			} else {
				$env->log( 'debug', 'padleft no pad width', $args );
				$cb( [ 'tokens' => [] ] );
			}
	}
	);
};

ParserFunctions::prototype::pf_padright = function ( $token, $frame, $cb, $params ) {
	$target = $params[ 0 ]->k;
	$env = $this->env;
	if ( !$params[ 1 ] ) {
		return $cb( [] );
	}
	// expand parameters 1 and 2
	$params->getSlice( [
			'type' => 'text/x-mediawiki/expanded'
		], 1, 3
	)->then( function ( $args ) use ( &$target, &$cb, &$env ) {
			$n = +( $args[ 0 ]->v );
			if ( $n > 0 ) {
				$pad = '0';
				if ( $args[ 1 ] && $args[ 1 ]->v !== '' ) {
					$pad = $args[ 1 ]->v;
				}
				$padLength = count( $pad );
				while ( ( count( $target ) + $padLength ) < $n ) {
					$target += $pad;
				}
				if ( count( $target ) < $n ) {
					$target += substr( $pad, 0, $n - count( $target ) );
				}
				$cb( [ 'tokens' => [ $target ] ] );
			} else {
				$env->log( 'debug', 'padright no pad width', $args );
				$cb( [ 'tokens' => [] ] );
			}
	}
	);
};

ParserFunctions::prototype::pf_tag = function ( $token, $frame, $cb, $args ) {
	// Check http://www.mediawiki.org/wiki/Extension:TagParser for more info
	// about the #tag parser function.
	$target = $args[ 0 ]->k;
	if ( !$target || $target === '' ) {
		$cb( [] );
	} else {
		// remove tag-name
		array_shift( $args );
		$this->tag_worker( $target, $cb, $args );
	}
};

ParserFunctions::prototype::tag_worker = function ( $target, $cb, $kvs ) use ( &$TagTk, &$EndTagTk ) {
	$contentToks = [];
	$tagAttribs = [];
	for ( $i = 0,  $n = count( $kvs );  $i < $n;  $i++ ) {
		if ( $kvs[ $i ]->k === '' ) {
			$contentToks = $contentToks->concat( $kvs[ $i ]->v );
		} else {
			$tagAttribs[] = $kvs[ $i ];
		}
	}

	$tokens = [ new TagTk( $target, $tagAttribs ) ]->concat(
		$contentToks,
		[ new EndTagTk( $target ) ]
	);
	$cb( [ 'tokens' => $tokens ] );
};

// TODO: These are just quick wrappers for now, optimize!
[
	[ 'year', 'Y' ], [ 'month', 'm' ], [ 'monthname', 'F' ], [ 'monthabbrev', 'M' ],
	[ 'week', 'W' ], [ 'day', 'j' ], [ 'day2', 'd' ], [ 'dow', 'w' ], [ 'dayname', 'l' ],
	[ 'time', 'H:i' ], [ 'hour', 'H' ], [ 'week', 'W' ],
	[ 'timestamp', 'YmdHis' ]
]->forEach( function ( $a ) {
		$name = $a[ 0 ];
		$format = $a[ 1 ];
		ParserFunctions::prototype[ 'pf_current' . $name ] =
		function ( $token, $frame, $cb, $args ) use ( &$format ) {
			$cb( $this->_pf_time_tokens( $format, [], [] ) );
		};
		ParserFunctions::prototype[ 'pf_local' . $name ] =
		function ( $token, $frame, $cb, $args ) use ( &$format ) {
			$cb( $this->_pf_timel_tokens( $format, [], [] ) );
		};
}
);
// XXX Actually use genitive form!
ParserFunctions::prototype::pf_currentmonthnamegen = function ( $token, $frame, $cb, $args ) {
	$cb( $this->_pf_time_tokens( 'F', [], [] ) );
};
ParserFunctions::prototype::pf_localmonthnamegen = function ( $token, $frame, $cb, $args ) {
	$cb( $this->_pf_timel_tokens( 'F', [], [] ) );
};

// A first approximation of time stuff.
// TODO: Implement time spec (+ 1 day etc), check if formats are complete etc.
// See http://www.mediawiki.org/wiki/Help:Extension:ParserFunctions#.23time
// for the full list of requirements!
//
// First (very rough) approximation below based on
// http://jacwright.com/projects/javascript/date_format/, MIT licensed.
ParserFunctions::prototype::pf_time = function ( $token, $frame, $cb, $args ) {
	$cb( [ 'tokens' => $this->_pf_time( $args[ 0 ]->k, array_slice( $args, 1 ) ) ] );
};

ParserFunctions::prototype::_pf_time_tokens = function ( $target, $args ) {
	return [ 'tokens' => $this->_pf_time( $target, $args ) ];
};
ParserFunctions::prototype::pf_timel = function ( $token, $frame, $cb, $args ) {
	$cb( [ 'tokens' => $this->_pf_time( $args[ 0 ]->k, array_slice( $args, 1 ), 'local' ) ] );
};

ParserFunctions::prototype::_pf_timel_tokens = function ( $target, $args ) {
	return [ 'tokens' => $this->_pf_time( $target, $args, 'local' ) ];
};

$ParsoidDate = null; // forward declaration

ParserFunctions::prototype::_pf_time = function ( $target, $args, $isLocal ) use ( &$ParsoidDate ) {
	$res = null;
	$tpl = trim( $target );
	$date = new ParsoidDate( $this->env, $isLocal );
	try {
		$res = [ $date->format( $tpl ) ];
	} catch ( Exception $e2 ) {
		$this->env->log( 'error', '#time ' . $e2 );
		$res = [ $date->toString() ];
	}
	return $res;
};

// Simulates PHP's date function
// NOTE that Javascript doesn't have a proper user-specified-timezone API.
// PHP format specifiers which return the name of the timezone (for example,
// 'e' and 'T') can't be implemented in JavaScript w/o the use of an external
// timezone database, like for instance https://github.com/mde/timezone-js
// CURRENTLY NO SUPPORT FOR NON-GREGORIAN CALENDARS
$ParsoidDate = function ( $env, $isLocal, $forcetime ) {
	$date = new Date();
	$offset = $date->getTimezoneOffset();
	// XXX: parse forcetime and change date
	// when testing, look aside to other date?
	if ( gettype( $env->conf->wiki->fakeTimestamp ) === 'number' ) {
		// php time stamps are in seconds; js timestamps are in milliseconds
		$date->setTime( $env->conf->wiki->fakeTimestamp * 1000 );
	}
	if ( gettype( $env->conf->wiki->timezoneOffset ) === 'number' ) {
		// this is the wiki's $wgLocaltimezone (if set)
		$offset = $env->conf->wiki->timezoneOffset;
	}
	if ( !$isLocal ) {
		$offset = 0; // UTC
	}
	$this->_date = $date;
	// _localdate is a date object which is, in UTC, the desired local time.
	// for example, if _date is 'Tue, 02 Apr 2013 21:30:44 GMT-0400 (EDT)'
	// then _localdate is       'Tue, 02 Apr 2013 21:30:44 GMT'
	$offset *= 60 * 1000; /* convert from minutes to milliseconds */
	$this->_localdate = new Date( $date->getTime() - $offset );
};
ParsoidDate::prototype::format = function ( $format ) use ( &$ParsoidDate ) {
	$returnStr = '';
	$replace = ParsoidDate::replaceChars;
	for ( $i = 0;  $i < count( $format );  $i++ ) {
		$curChar = $format->charAt( $i );
		if ( $i - 1 >= 0 && $format->charAt( $i - 1 ) === '\\' ) {
			$returnStr += $curChar;
		} elseif ( $replace[ $curChar ] ) {
			$returnStr += call_user_func( [ $replace, 'curChar' ] );
		} elseif ( $curChar !== '\\' ) {
			$returnStr += $curChar;
		}
	}
	return $returnStr;
};
ParsoidDate::prototype::toString = function () {
	return $this->format( 'D, d M Y H:i:s O' );
};
ParsoidDate::prototype::getTimezoneOffset = function () {
	return ( $this->_date->getTime() - $this->_localdate->getTime() ) / ( 60 * 1000 );
};
$getJan1 = function ( $d ) {
	$d = new Date( $d->getTime() );
	$d->setUTCMonth( 0 );
	$d->setUTCDate( 1 );
	$d->setUTCHours( 0 );
	$d->setUTCMinutes( 0 );
	$d->setUTCSeconds( 0 );
	$d->setUTCMilliseconds( 0 );
	return $d;
};
ParsoidDate::prototype::getWeek = function () use ( &$getJan1 ) {
	$start = $getJan1( $this->_localdate );
	return ceil( ( ( ( $this->_localdate->valueOf() - $start->valueOf() ) / 86400000 ) + $start->getUTCDay() + 1 ) / 7 );
};
ParsoidDate::prototype::getWeekYear = function () { // ISO-8601 week year
	$d = new Date( $this->_localdate );
	$d->setUTCDate( $d->getUTCDate() - ( ( $d->getUTCDay() + 6 ) % 7 ) + 3 );
	return $d->getUTCFullYear();
};
ParsoidDate::prototype::getDayOfYear = function () use ( &$getJan1 ) {
	$start = $getJan1( $this->_localdate );
	return ceil( ( $this->_localdate->valueOf() - $start->valueOf() ) / 86400000 );
};
// proxy certain methods of _date into ParsoidDate.
[
	'getUTCHours', 'getUTCMinutes', 'getUTCSeconds',
	'getTime', 'valueOf'
]->forEach( function ( $f ) use ( &$ParsoidDate ) {
		ParsoidDate::prototype[ $f ] = function () {
			$d = $this->_date;
			return call_user_func_array( [ $d, 'f' ], $arguments );
		};
}
);
// local dates use UTC methods, but on _localdate
[
	'getHours', 'getMinutes', 'getSeconds', 'getMilliseconds',
	'getDate', 'getDay', 'getMonth', 'getFullYear'
]->forEach( function ( $f ) use ( &$ParsoidDate ) {
		$ff = str_replace( 'get', 'getUTC', $f );
		ParsoidDate::prototype[ $f ] = function () {
			$d = $this->_localdate;
			return call_user_func_array( [ $d, 'ff' ], $arguments );
		};
}
);

// XXX: support localization
ParsoidDate::replaceChars = [
	'shortMonths' => [
		'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug',
		'Sep', 'Oct', 'Nov', 'Dec'
	],
	'longMonths' => [
		'January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'
	],
	'shortDays' => [ 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat' ],
	'longDays' => [
		'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday',
		'Friday', 'Saturday'
	],

	// Day
	'd' => function () { return ( ( $this->getDate() < 10 ) ? '0' : '' ) + $this->getDate();
 },
	'D' => function () use ( &$ParsoidDate ) { return ParsoidDate::replaceChars::shortDays[ $this->getDay() ];
 },
	'j' => function () { return $this->getDate();
 },
	'l' => function () use ( &$ParsoidDate ) { return ParsoidDate::replaceChars::longDays[ $this->getDay() ];
 },
	'N' => function () { return $this->getDay() + 1;
 },
	'S' => function () {
		return ( ( $this->getDate() % 10 === 1
&& $this->getDate() !== 11
		) ? 'st' : ( ( $this->getDate() % 10 === 2
&& $this->getDate() !== 12
		) ? 'nd' : ( ( $this->getDate() % 10 === 3
&& $this->getDate() !== 13
		) ? 'rd' : 'th' ) ) );
	},
	'w' => function () { return $this->getDay();
 },
	'z' => function () { return $this->getDayOfYear();
 },
	// Week
	'W' => function () { return $this->getWeek();
 },
	// Month
	'F' => function () use ( &$ParsoidDate ) { return ParsoidDate::replaceChars::longMonths[ $this->getMonth() ];
 },
	'm' => function () { return ( ( $this->getMonth() < 9 ) ? '0' : '' ) + ( $this->getMonth() + 1 );
 },
	'M' => function () use ( &$ParsoidDate ) { return ParsoidDate::replaceChars::shortMonths[ $this->getMonth() ];
 },
	'n' => function () { return $this->getMonth() + 1;
 },
	't' => function () {
		return new Date( $this->getFullYear(), $this->getMonth() + 1, 0 )->getDate();
	},
	// Year
	'L' => function () {
		$year = $this->getFullYear();
		return ( $year % 400 === 0 || ( $year % 100 !== 0 && $year % 4 === 0 ) );
	},
	'o' => function () { return $this->getWeekYear();
 },
	'Y' => function () { return $this->getFullYear();
 },
	'y' => function () { return substr( ( '' . $this->getFullYear() ), 2 );
 },
	// Time
	'a' => function () { return ( $this->getHours() < 12 ) ? 'am' : 'pm';
 },
	'A' => function () { return ( $this->getHours() < 12 ) ? 'AM' : 'PM';
 },
	'B' => function () {
		return floor( ( ( ( $this->getUTCHours() + 1 ) % 24 )
+ $this->getUTCMinutes() / 60
+ $this->getUTCSeconds() / 3600 ) * 1000 / 24
		);
	},
	'g' => function () { return $this->getHours() % 12 || 12;
 },
	'G' => function () { return $this->getHours();
 },
	'h' => function () {
		return ( ( ( $this->getHours() % 12 || 12 ) < 10 ) ? '0' : '' )
+ ( $this->getHours() % 12 || 12 );
	},
	'H' => function () { return ( ( $this->getHours() < 10 ) ? '0' : '' ) + $this->getHours();
 },
	'i' => function () { return ( ( $this->getMinutes() < 10 ) ? '0' : '' ) + $this->getMinutes();
 },
	's' => function () { return ( ( $this->getSeconds() < 10 ) ? '0' : '' ) + $this->getSeconds();
 },
	'u' => function () {
		$m = $this->getMilliseconds();
		return ( ( $m < 10 ) ? '00' : ( ( $m < 100 ) ? '0' : '' ) ) + $m;
	},
	// Timezone
	'e' => function () { return 'Not Yet Supported';
 },
	'I' => function () { return 'Not Yet Supported';
 },
	'O' => function () {
		return ( ( -$this->getTimezoneOffset() < 0 ) ? '-' : '+' )
+ ( ( abs( $this->getTimezoneOffset() / 60 ) < 10 ) ? '0' : '' )
+ ( abs( $this->getTimezoneOffset() / 60 ) ) . '00';
	},
	'P' => function () {
		return ( ( -$this->getTimezoneOffset() < 0 ) ? '-' : '+' )
+ ( ( abs( $this->getTimezoneOffset() / 60 ) < 10 ) ? '0' : '' )
+ ( abs( $this->getTimezoneOffset() / 60 ) ) . ':00';
	},
	'T' => function () { return 'Not Yet Supported';
 },
	'Z' => function () { return -$this->getTimezoneOffset() * 60;
 },
	// Full Date/Time
	'c' => function () { return $this->format( 'Y-m-d\TH:i:sP' );
 },
	'r' => function () { return $this->toString();
 },
	'U' => function () { return $this->getTime() / 1000;
 }
];

ParserFunctions::prototype::pf_localurl = function ( $token, $frame, $cb, $args ) use ( &$Promise ) {
	$target = $args[ 0 ]->k;
	$env = $this->env;
	$args = array_slice( $args, 1 );
	Promise::all( array_map( $args, function ( $item ) {return new Promise( function ( $resolve, $reject ) use ( &$item ) {
						// FIXME: we are swallowing all errors
						$resCB = buildAsyncOutputBufferCB( $resolve );
						$this->expandKV( $item, $resCB, '', 'text/x-mediawiki/expanded', false );
	}
				);
	}
		)

	)->then( function ( $expandedArgs ) use ( &$cb, &$env, &$target ) {
			$cb( [
					'tokens' => [
						$env->conf->wiki->script . '?title='
. $env->normalizedTitleKey( $target ) . '&'
. implode( '&', $expandedArgs )
					]
				]
			);
	}
	)->done();
};

/* Stub section: Pick any of these and actually implement them!  */

// The page name and similar information should be carried around in
// this.env
ParserFunctions::prototype::pf_formatnum = function ( $token, $frame, $cb, $args ) {
	$target = $args[ 0 ]->k;
	$cb( [ 'tokens' => [ $target ] ] );
};
ParserFunctions::prototype::pf_currentpage = function ( $token, $frame, $cb, $args ) {
	$target = $args[ 0 ]->k;
	$cb( [ 'tokens' => [ $target ] ] );
};
ParserFunctions::prototype::pf_pagenamee = function ( $token, $frame, $cb, $args ) {
	$target = $args[ 0 ]->k;
	$cb( [ 'tokens' => [ explode( ':', 2, $target )[ 1 ] || '' ] ] );
};
ParserFunctions::prototype::pf_fullpagename = function ( $token, $frame, $cb, $args ) {
	$target = $args[ 0 ]->k;
	$cb( [ 'tokens' => [ $target || $this->env->page->name || '' ] ] );
};
ParserFunctions::prototype::pf_fullpagenamee = function ( $token, $frame, $cb, $args ) {
	$target = $args[ 0 ]->k;
	$cb( [ 'tokens' => [ $target || $this->env->page->name || '' ] ] );
};
ParserFunctions::prototype::pf_pagelanguage = function ( $token, $frame, $cb, $args ) {
	// The language (code) of the current page.
	$cb( [ 'tokens' => [ $this->env->page->pagelanguage || 'en' ] ] );
};
ParserFunctions::prototype::pf_dirmark =
ParserFunctions::prototype::pf_directionmark = function ( $token, $frame, $cb, $args ) use ( &$Util ) {
	// The directionality of the current page.
	$dir = $this->env->page->pagelanguagedir
|| ( ( $this->env->conf->wiki->rtl ) ? 'rtl' : 'ltr' );
	$mark = ( $dir === 'rtl' ) ? '&rlm;' : '&lrm;';
	// See Parser.php::getVariableValue()
	$cb( [ 'tokens' => [ Util::decodeWtEntities( $mark ) ] ] );
};
// This should be doable with the information in the envirionment
// (this.env) already.
ParserFunctions::prototype::pf_fullurl = function ( $token, $frame, $cb, $args ) {
	$target = str_replace( ' ', '_', ( $args[ 0 ]->k || $this->env->page->name ) );
	$wikiConf = $this->env->conf->wiki;
	$url = null;
	if ( $args[ 1 ] ) {
		$url = $wikiConf->server + $wikiConf->script . '?title=' . encodeURIComponent( $target ) . '&' . $args[ 1 ]->k . '=' . $args[ 1 ]->v;
	} else {
		$url = $wikiConf->baseURI + implode( '/', array_map( explode( '/', str_replace( ' ', '_', $target ) ), $encodeURIComponent ) );
	}
	$cb( [ 'tokens' => [ $url ] ] );
};
ParserFunctions::prototype::pf_urlencode = function ( $token, $frame, $cb, $args ) {
	$target = $args[ 0 ]->k;
	$cb( [ 'tokens' => [ encodeURIComponent( trim( $target ) ) ] ] );
};

// The following items all depends on information from the Wiki, so are hard
// to implement independently. Some might require using action=parse in the
// API to get the value. See
// http://www.mediawiki.org/wiki/Parsoid#Token_stream_transforms,
// http://etherpad.wikimedia.org/ParserNotesExtensions and
// http://www.mediawiki.org/wiki/Wikitext_parser/Environment.
// There might be better solutions for some of these.
ParserFunctions::prototype::pf_ifexist = function ( $token, $frame, $cb, $args ) {
	$this->expandKV( $args[ 1 ], $cb );
};
ParserFunctions::prototype::pf_pagesize = function ( $token, $frame, $cb, $args ) {
	$cb( [ 'tokens' => [ '100' ] ] );
};
ParserFunctions::prototype::pf_sitename = function ( $token, $frame, $cb, $args ) {
	$cb( [ 'tokens' => [ 'MediaWiki' ] ] );
};
ParserFunctions::prototype::pf_anchorencode = function ( $token, $frame, $cb, $args ) use ( &$Sanitizer, &$Util ) {
	$target = $args[ 0 ]->k;
	// Parser::guessSectionNameFromWikiText, which invokes
	// Sanitizer::normalizeSectionNameWhitespace and
	// Sanitizer::escapeIdForLink, then calls
	// Sanitizer::safeEncodeAttribute on the result. See: T179544
	$target = trim( preg_replace( '/[ _]+/', ' ', $target ) );
	$target = Sanitizer::decodeCharReferences( $target );
	$target = Sanitizer::escapeIdForLink( $target );
	$tokens = [];
	$charEntity = function ( $c ) use ( &$Util, &$tokens ) {
		$enc = Util::entityEncodeAll( $c );
		array_push( $tokens,
			new TagTk(
				'span',
				[ new KV( 'typeof', 'mw:Entity' ) ],
				[ 'src' => $enc, 'srcContent' => $c ]
			),
			$c,
			new EndTagTk( 'span', [], [] )
		);
	};
	preg_split( "/([\\{\\}\\[\\]|]|''|ISBN|RFC|PMID|__)/", $target )->forEach( function ( $s, $i ) use ( &$tokens, &$charEntity ) {
			if ( ( $i % 2 ) === 0 ) {
				$tokens[] = $s;
			} elseif ( $s === "''" ) {
				$charEntity( $s[ 0 ] );
$charEntity( $s[ 1 ] );
			} else {
				$charEntity( $s[ 0 ] );
$tokens[] = array_slice( $s, 1 );
			}
	}
	);
	$cb( [ 'tokens' => $tokens ] );
};
ParserFunctions::prototype::pf_protectionlevel = function ( $token, $frame, $cb, $args ) {
	$cb( [ 'tokens' => [ '' ] ] );
};
ParserFunctions::prototype::pf_ns = function ( $token, $frame, $cb, $args ) {
	$nsid = null;
	$target = $args[ 0 ]->k;
	$env = $this->env;
	$normalizedTarget = str_replace( ' ', '_', strtolower( $target ) );

	if ( $env->conf->wiki->namespaceIds->has( $normalizedTarget ) ) {
		$nsid = $env->conf->wiki->namespaceIds->get( $normalizedTarget );
	} elseif ( $env->conf->wiki->canonicalNamespaces[ $normalizedTarget ] ) {
		$nsid = $env->conf->wiki->canonicalNamespaces[ $normalizedTarget ];
	}

	if ( $nsid !== null && $env->conf->wiki->namespaceNames[ $nsid ] ) {
		$target = $env->conf->wiki->namespaceNames[ $nsid ];
	}
	$cb( [ 'tokens' => [ $target ] ] );
};
ParserFunctions::prototype::pf_subjectspace = function ( $token, $frame, $cb, $args ) {
	$cb( [ 'tokens' => [ 'Main' ] ] );
};
ParserFunctions::prototype::pf_talkspace = function ( $token, $frame, $cb, $args ) {
	$cb( [ 'tokens' => [ 'Talk' ] ] );
};
ParserFunctions::prototype::pf_numberofarticles = function ( $token, $frame, $cb, $args ) {
	$cb( [ 'tokens' => [ '1' ] ] );
};
ParserFunctions::prototype::pf_language = function ( $token, $frame, $cb, $args ) {
	$target = $args[ 0 ]->k;
	$cb( [ 'tokens' => [ $target ] ] );
};
ParserFunctions::prototype::pf_contentlang =
ParserFunctions::prototype::pf_contentlanguage = function ( $token, $frame, $cb, $args ) {
	// Despite the name, this returns the wiki's default interface language
	// ($wgLanguageCode), *not* the language of the current page content.
	$cb( [ 'tokens' => [ $this->env->conf->wiki->lang || 'en' ] ] );
};
ParserFunctions::prototype::pf_numberoffiles = function ( $token, $frame, $cb, $args ) {
	$cb( [ 'tokens' => [ '2' ] ] );
};
ParserFunctions::prototype::pf_namespace = function ( $token, $frame, $cb, $args ) {
	$target = $args[ 0 ]->k;
	$cb( [ 'tokens' => [ array_pop( explode( ':', $target ) ) || 'Main' ] ] );
};
ParserFunctions::prototype::pf_namespacee = function ( $token, $frame, $cb, $args ) {
	$target = $args[ 0 ]->k;
	$cb( [ 'tokens' => [ array_pop( explode( ':', $target ) ) || 'Main' ] ] );
};
ParserFunctions::prototype::pf_namespacenumber = function ( $token, $frame, $cb, $args ) {
	$target = array_pop( explode( ':', $args[ 0 ]->k ) );
	$cb( [ 'tokens' => [ String( $this->env->conf->wiki->namespaceIds->get( $target ) ) ] ] );
};
ParserFunctions::prototype::pf_pagename = function ( $token, $frame, $cb, $args ) {
	$cb( [ 'tokens' => [ $this->env->page->name || '' ] ] );
};
ParserFunctions::prototype::pf_pagenamebase = function ( $token, $frame, $cb, $args ) {
	$cb( [ 'tokens' => [ $this->env->page->name || '' ] ] );
};
ParserFunctions::prototype::pf_scriptpath = function ( $token, $frame, $cb, $args ) {
	$cb( [ 'tokens' => [ $this->env->conf->wiki->scriptpath ] ] );
};
ParserFunctions::prototype::pf_server = function ( $token, $frame, $cb, $args ) use ( &$Util, &$TagTk, &$KV, &$EndTagTk ) {
	$dataAttribs = Util::clone( $token->dataAttribs );
	$cb( [
			'tokens' => [
				new TagTk( 'a', [
						new KV( 'rel', 'nofollow' ),
						new KV( 'class', 'external free' ),
						new KV( 'href', $this->env->conf->wiki->server ),
						new KV( 'typeof', 'mw:ExtLink/URL' )
					], $dataAttribs
				),
				$this->env->conf->wiki->server,
				new EndTagTk( 'a' )
			]
		]
	);
};
ParserFunctions::prototype::pf_servername = function ( $token, $frame, $cb, $args ) {
	$cb( [ 'tokens' => [ preg_replace( '/^https?:\/\//', '', $this->env->conf->wiki->server, 1 ) ] ] );
};
ParserFunctions::prototype::pf_talkpagename = function ( $token, $frame, $cb, $args ) {
	$cb( [ 'tokens' => [ preg_replace( '/^[^:]:/', 'Talk:', $this->env->page->name, 1 ) || '' ] ] );
};
ParserFunctions::prototype::pf_defaultsort = function ( $token, $frame, $cb, $args ) use ( &$SelfclosingTagTk, &$KV ) {
	$key = $args[ 0 ]->k;
	$cb( [
			'tokens' => [
				new SelfclosingTagTk( 'meta', [
						new KV( 'property', 'mw:PageProp/categorydefaultsort' ),
						new KV( 'content', trim( $key ) )
					]
				)
			]
		]
	);
};
ParserFunctions::prototype::pf_displaytitle = function ( $token, $frame, $cb, $args ) use ( &$SelfclosingTagTk, &$KV ) {
	$key = $args[ 0 ]->k;
	$cb( [
			'tokens' => [
				new SelfclosingTagTk( 'meta', [
						new KV( 'property', 'mw:PageProp/displaytitle' ),
						new KV( 'content', trim( $key ) )
					]
				)
			]
		]
	);
};

// TODO: #titleparts, SUBJECTPAGENAME, BASEPAGENAME. SUBPAGENAME, DEFAULTSORT

if ( gettype( $module ) === 'object' ) {
	$module->exports->ParserFunctions = $ParserFunctions;
}
