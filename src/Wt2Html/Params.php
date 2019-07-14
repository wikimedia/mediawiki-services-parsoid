<?php

namespace Parsoid\Wt2Html;

use Parsoid\Tokens\KV;
use Parsoid\Utils\TokenUtils;

/**
 * A parameter object wrapper, essentially an array of key/value pairs with a few extra methods.
 */
class Params {
	/** @phan-var KV[] */
	public $args;

	/** @var array */
	public $argDict;

	/** @var array */
	public $namedArgsDict;

	/**
	 * @param array $args
	 */
	public function __construct( $args ) {
		$this->args = $args;
		$this->argDict = null;
		$this->namedArgsDict = null;
	}

	/**
	 * PORT-FIXME: Used in Parsoid native parser functions implementation
	 * and may not be needed in the final version.
	 *
	 * Converts the args that are an array of ($k, $v) KV objects to
	 * an assocative array mapping $k to $v.
	 *
	 * @return array
	 */
	public function dict(): array {
		if ( $this->argDict === null ) {
			$res = [];
			for ( $i = 0,  $l = count( $this->args );  $i < $l;  $i++ ) {
				$kv = $this->args[$i];
				$key = trim( TokenUtils::tokensToString( $kv->k ) );
				$res[$key] = $kv->v;
			}
			$this->argDict = $res;
		}
		return $this->argDict;
	}

	/**
	 * Converts the args that are an array of ($k, $v) KV objects to
	 * an assocative array mapping $k to $v while handling named and
	 * locational orgs and trimming whitespace around the keys.
	 *
	 * @return array
	 */
	public function named(): array {
		if ( $this->namedArgsDict === null ) {
			$n = 1;
			$out = [];
			$namedArgs = [];

			for ( $i = 0,  $l = count( $this->args );  $i < $l;  $i++ ) {
				// FIXME: Also check for whitespace-only named args!
				$k = $this->args[$i]->k;
				$v = $this->args[$i]->v;
				if ( is_string( $k ) ) {
					$k = trim( $k );
				}
				if ( !is_array( $k ) &&
					// Check for blank named parameters
					$this->args[$i]->srcOffsets->key->end === $this->args[$i]->srcOffsets->value->start
				) {
					$out[(string)$n] = $v;
					$n++;
				} elseif ( is_string( $k ) ) {
					$namedArgs[$k] = true;
					$out[$k] = $v;
				} else {
					$k = trim( TokenUtils::tokensToString( $k ) );
					$namedArgs[$k] = true;
					$out[$k] = $v;
				}
			}
			$this->namedArgsDict = [ 'namedArgs' => $namedArgs, 'dict' => $out ];
		}

		return $this->namedArgsDict;
	}

	/**
	 * PORT-FIXME: Used in Parsoid native parser functions implementation
	 * and may not be needed in the final version.
	 *
	 * @param int $start
	 * @param int $end
	 * @return array
	 */
	public function getSlice( int $start, int $end ): array {
		$out = [];
		$args = array_slice( $this->args, $start, $end /*CHECK THIS*/ );
		foreach ( $args as $kv ) {
			$out[] = new KV( $kv->k, TokenUtils::tokensToString( $kv->v ), $kv->srcOffsets );
		}
		return $out;
	}
}
