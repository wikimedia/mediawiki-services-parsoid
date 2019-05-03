<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * Serializes language variant markup, like `-{ ... }-`.
 * @module
 */

namespace Parsoid;

$Consts = require( '../config/WikitextConstants.js' )::WikitextConstants;
$DOMDataUtils = require( '../utils/DOMDataUtils.js' )::DOMDataUtils;
$Promise = require( '../utils/promise.js' );
$Util = require( '../utils/Util.js' )::Util;
$LanguageVariantText = require( './ConstrainedText.js' )::LanguageVariantText;

$expandSpArray = function ( $a ) {
	$result = [];
	if ( is_array( $a ) ) {
		$a->forEach( function ( $el ) use ( &$result ) {
				if ( gettype( $el ) === 'number' ) {
					for ( $i = 0;  $i < $el;  $i++ ) {
						$result[] = '';
					}
				} else {
					$result[] = $el;
				}
			}
		);
	}
	return $result;
};

/**
 * @function
 * @param {Node} node
 * @return {Promise}
 */
$languageVariantHandler = /* async */function ( $state, $node ) use ( &$DOMDataUtils, &$expandSpArray, &$Util, &$LanguageVariantText ) {
	$dataMWV = DOMDataUtils::getJSONAttribute( $node, 'data-mw-variant', [] );
	$dp = DOMDataUtils::getDataParsoid( $node );
	$flSp = $expandSpArray( $dp->flSp );
	$textSp = $expandSpArray( $dp->tSp );
	$trailingSemi = false;
	$text = null;
	$flags = null;
	$originalFlags = array_reduce( ( $dp->fl || [] ), function ( $m, $k, $idx ) {
			if ( !$m->has( $k ) ) { $m->set( $k, $idx );  }
			return $m;
		}, new Map()
	)


	;
	$result = '$E|'; // "error" flag

	// Backwards-compatibility: `bidir` => `twoway` ; `unidir` => `oneway`
	// "error" flag

	// Backwards-compatibility: `bidir` => `twoway` ; `unidir` => `oneway`
	if ( $dataMWV->bidir ) {
		$dataMWV->twoway = $dataMWV->bidir;
		unset( $dataMWV->bidir );
	}
	if ( $dataMWV->unidir ) {
		$dataMWV->oneway = $dataMWV->undir;
		unset( $dataMWV->unidir );
	}

	$flags = array_reduce( Object::keys( $dataMWV ), function ( $f, $k ) {
			if ( Consts\LCNameMap::has( $k ) ) {
				$f->add( Consts\LCNameMap::get( $k ) );
			}
			return $f;
		}, new Set()
	)




	;
	$maybeDeleteFlag = function ( $f ) use ( &$originalFlags, &$flags ) {
		if ( !$originalFlags->has( $f ) ) { $flags->delete( $f );  }
	};

	// Tweak flag set to account for implicitly-enabled flags.
	// Tweak flag set to account for implicitly-enabled flags.
	if ( $node->tagName !== 'META' ) {
		$flags->add( '$S' );
	}
	if ( !$flags->has( '$S' ) && !$flags->has( 'T' ) && $dataMWV->filter === null ) {
		$flags->add( 'H' );
	}
	if ( $flags->size === 1 && $flags->has( '$S' ) ) {
		$maybeDeleteFlag( '$S' );
	} elseif ( $flags->has( 'D' ) ) {
		// Weird: Only way to hide a 'describe' rule is to write -{D;A|...}-
		if ( $flags->has( '$S' ) ) {
			if ( $flags->has( 'A' ) ) {
				$flags->add( 'H' );
			}
			$flags->delete( 'A' );
		} else {
			$flags->add( 'A' );
			$flags->delete( 'H' );
		}
	} elseif ( $flags->has( 'T' ) ) {
		if ( $flags->has( 'A' ) && !$flags->has( '$S' ) ) {
			$flags->delete( 'A' );
			$flags->add( 'H' );
		}
	} elseif ( $flags->has( 'A' ) ) {
		if ( $flags->has( '$S' ) ) {
			$maybeDeleteFlag( '$S' );
		} elseif ( $flags->has( 'H' ) ) {
			$maybeDeleteFlag( 'A' );
		}
	} elseif ( $flags->has( 'R' ) ) {
		$maybeDeleteFlag( '$S' );
	} elseif ( $flags->has( '-' ) ) {
		$maybeDeleteFlag( 'H' );
	}

	// Helper function: serialize a DOM string; returns a Promise
	// Helper function: serialize a DOM string; returns a Promise
	$ser = function ( $t, $opts ) use ( &$state ) {
		$options = Object::assign( [
				'env' => $state->env,
				'onSOL' => false
			], $opts || []
		);
		return $state->serializer->serializeHTML( $options, $t );
	};

	// Helper function: protect characters not allowed in language names.
	// Helper function: protect characters not allowed in language names.
	$protectLang = function ( $l ) use ( &$Util ) {
		if ( preg_match( '/^[a-z][-a-z]+$/', $l ) ) { return $l;  }
		return '<nowiki>' . Util::escapeWtEntities( $l ) . '</nowiki>';
	};

	// Helper function: combine the three parts of the -{ }- string
	// Helper function: combine the three parts of the -{ }- string
	$combine = function ( $flagStr, $bodyStr, $useTrailingSemi ) {
		if ( $flagStr || preg_match( '/\|/', $bodyStr ) ) { $flagStr += '|';  }
		if ( $useTrailingSemi !== false ) { $bodyStr += ';' . $useTrailingSemi;  }
		return $flagStr + $bodyStr;
	};

	// Canonicalize combinations of flags.
	// Canonicalize combinations of flags.
	$sortedFlags = function ( $flags, $noFilter, $protectFunc ) use ( &$flags, &$originalFlags, &$flSp ) {
		$s = implode(















			';', array_map( Array::from( $flags )->filter( function ( $f ) {
						// Filter out internal-use-only flags
						if ( $noFilter ) { return true;  }
						return !preg_match( '/^[$]/', $f );
					}
				)->sort( function ( $a, $b ) {
						$ai = ( $originalFlags->has( $a ) ) ? $originalFlags->get( $a ) : -1;
						$bi = ( $originalFlags->has( $b ) ) ? $originalFlags->get( $b ) : -1;
						return $ai - $bi;
					}
				), function ( $f ) {
					// Reinsert the original whitespace around the flag (if any)
					$i = $originalFlags->get( $f );
					$p = ( $protectFunc ) ? protectFunc( $f ) : $f;
					if ( $i !== null && ( 2 * $i + 1 ) < count( $flSp ) ) {
						return $flSp[ 2 * $i ] + $p + $flSp[ 2 * $i + 1 ];
					}
					return $p;
				}
			)







		);
		if ( 2 * $originalFlags->size + 1 === count( $flSp ) ) {
			if ( count( $flSp ) > 1 || count( $s ) ) { $s += ';';  }
			$s += $flSp[ 2 * $originalFlags->size ];
		}
		return $s;
	};

	if ( $dataMWV->filter && $dataMWV->filter->l ) {
		// "Restrict possible variants to a limited set"
		$text = /* await */ $ser( $dataMWV->filter->t, [ 'protect' => /* RegExp */ '/\}-/' ] );
		Assert::invariant( $flags->size === 0 );
		$result = $combine(
			$sortedFlags( $dataMWV->filter->l, true, $protectLang ),
			$text,
			false/* no trailing semi */
		);
	} else /* no trailing semi */
	if ( $dataMWV->disabled || $dataMWV->name ) {
		// "Raw" / protect contents from language converter
		$text = /* await */ $ser( ( $dataMWV->disabled || $dataMWV->name )->t, [ 'protect' => /* RegExp */ '/\}-/' ] );
		if ( !preg_match( '/[:;|]/', $text ) ) {
			$maybeDeleteFlag( 'R' );
		}
		$result = $combine( $sortedFlags( $flags ), $text, false );
	} elseif ( is_array( $dataMWV->twoway ) ) {
		// Two-way rules (most common)
		if ( count( $textSp ) % 3 === 1 ) {
			$trailingSemi = $textSp[ count( $textSp ) - 1 ];
		}
		$b = ( $dataMWV->twoway[ 0 ] && $dataMWV->twoway[ 0 ]->l === '*' ) ?
		array_slice( $dataMWV->twoway, 0, 1/*CHECK THIS*/ ) :
		$dataMWV->twoway;
		$text = implode(









			';', ( /* await */ Promise::all( array_map( $b, /* async */function ( $rule, $idx ) {
						$text = /* await */ ser( $rule->t, [ 'protect' => /* RegExp */ '/;|\}-/' ] );
						if ( $rule->l === '*' ) {
							$trailingSemi = false;
							return $text;
						}
						$ws = ( 3 * $idx + 2 < count( $textSp ) ) ?
						array_slice( $textSp, 3 * $idx, 3 * ( $idx + 1 )/*CHECK THIS*/ ) :
						[ ( $idx > 0 ) ? ' ' : '', '', '' ];
						return $ws[ 0 ] + protectLang( $rule->l ) + $ws[ 1 ] . ':' . $ws[ 2 ] . $text;
					}









				)









			) )
		);
		// suppress output of default flag ('S')
		// suppress output of default flag ('S')
		$maybeDeleteFlag( '$S' );
		$result = $combine( $sortedFlags( $flags ), $text, $trailingSemi );
	} elseif ( is_array( $dataMWV->oneway ) ) {
		// One-way rules (uncommon)
		if ( count( $textSp ) % 4 === 1 ) {
			$trailingSemi = $textSp[ count( $textSp ) - 1 ];
		}
		$text = implode(







			';', ( /* await */ Promise::all( array_map( $dataMWV->oneway, /* async */function ( $rule, $idx ) {
						$from = /* await */ ser( $rule->f, [ 'protect' => /* RegExp */ '/:|;|=>|\}-/' ] );
						$to = /* await */ ser( $rule->t, [ 'protect' => /* RegExp */ '/;|\}-/' ] );
						$ws = ( 4 * $idx + 3 < count( $textSp ) ) ?
						array_slice( $textSp, 4 * $idx, 4 * ( $idx + 1 )/*CHECK THIS*/ ) :
						[ '', '', '', '' ];
						return $ws[ 0 ] + $from . '=>' . $ws[ 1 ] . protectLang( $rule->l )
.							$ws[ 2 ] . ':' . $ws[ 3 ] . $to;
					}







				)







			) )
		);
		$result = $combine( $sortedFlags( $flags ), $text, $trailingSemi );
	}
	$state->emitChunk( new LanguageVariantText( '-{' . $result . '}-', $node ), $node );
}












































































































































































;

if ( gettype( $module ) === 'object' ) {
	$module->exports->languageVariantHandler = $languageVariantHandler;
}
