<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module wt2html/Params */

namespace Parsoid;

use Parsoid\Promise as Promise;
use Parsoid\KV as KV;

$TokenUtils = require '../utils/TokenUtils.js'::TokenUtils;

/**
 * A parameter object wrapper, essentially an array of key/value pairs with a
 * few extra methods.
 *
 * @class
 * @extends Array
 */
class Params extends array {
	public function __construct( $params ) {
		parent::__construct( count( $params ) );
		for ( $i = 0;  $i < count( $params );  $i++ ) {
			$this[ $i ] = $params[ $i ];
		}
		$this->argDict = null;
		$this->namedArgsDict = null;
	}
	public $i;

	public $argDict;
	public $namedArgsDict;

	public function dict() {
		if ( $this->argDict === null ) {
			$res = [];
			for ( $i = 0,  $l = count( $this );  $i < $l;  $i++ ) {
				$kv = $this[ $i ];
				$key = trim( TokenUtils::tokensToString( $kv->k ) );
				$res[ $key ] = $kv->v;
			}
			$this->argDict = $res;
		}
		return $this->argDict;
	}

	public function named() {
		if ( $this->namedArgsDict === null ) {
			$n = 1;
			$out = [];
			$namedArgs = [];

			for ( $i = 0,  $l = count( $this );  $i < $l;  $i++ ) {
				// FIXME: Also check for whitespace-only named args!
				$k = $this[ $i ]->k;
				$v = $this[ $i ]->v;
				if ( $k->constructor === $String ) {
					$k = trim( $k );
				}
				if ( !count( $k )
&& // Check for blank named parameters
						$this[ $i ]->srcOffsets[ 1 ] === $this[ $i ]->srcOffsets[ 2 ]
				) {
					$out[ $n->toString() ] = $v;
					$n++;
				} elseif ( $k->constructor === $String ) {
					$namedArgs[ $k ] = true;
					$out[ $k ] = $v;
				} else {
					$k = trim( TokenUtils::tokensToString( $k ) );
					$namedArgs[ $k ] = true;
					$out[ $k ] = $v;
				}
			}
			$this->namedArgsDict = [ 'namedArgs' => $namedArgs, 'dict' => $out ];
		}

		return $this->namedArgsDict;
	}

	/**
	 * Expand a slice of the parameters using the supplied get options.
	 * @return Promise
	 */
	public function getSlice( $options, $start, $end ) {
		$args = array_slice( $this, $start, $end/*CHECK THIS*/ );
		return Promise::all( array_map( $args, /* async */function ( $kv ) { // eslint-disable-line require-yield
					$k = $kv->k;
					$v = $kv->v;
					if ( is_array( $v ) && count( $v ) === 1 && $v[ 0 ]->constructor === $String ) {
						// remove String from Array
						$kv = new KV( $k, $v[ 0 ], $kv->srcOffsets );
					} elseif ( $v->constructor !== $String ) {
						$kv = new KV( $k, TokenUtils::tokensToString( $v ), $kv->srcOffsets );
					}
					return $kv;
		}

			)

		);
	}
}

if ( gettype( $module ) === 'object' ) {
	$module->exports = [
		'Params' => $Params
	];
}
