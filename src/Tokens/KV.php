<?php

namespace Parsoid\Tokens;

/**
 * Represents a Key-value pair.
 */
class KV {
	/** @var mixed Commonly a string, but where the key might be templated,
	 *  this can be an array of tokens even. */
	public $k;

	/** @var mixed string, Token, or an array of tokens even */
	public $v;

	/**
	 * @param mixed $k
	 *     Commonly a string, but where the key might be templated,
	 *     this can be an array of tokens even.
	 * @param mixed $v
	 *     The value: string, token, of an array of tokens
	 * @param array|null $srcOffsets wikitext source offsets
	 * @param string|null $vsrc wikitext source
	 */
	public function __construct( $k, $v, array $srcOffsets = null, $vsrc = null ) {
		$this->k = $k;
		$this->v = $v;
		$this->srcOffsets = $srcOffsets;
		$this->vsrc = $vsrc;
	}

	/**
	 * Lookup a string key in a KV array and return the first matching KV object
	 *
	 * @param array $kvs
	 * @param string $key
	 * @return KV|null
	 */
	public static function lookupKV( array $kvs, $key ) {
		if ( $kvs === null ) {
			return null;
		}

		foreach ( $kvs as $kv ) {
			// PORT-FIXME: JS trim() will remove non-ASCII spaces (such as NBSP) too,
			// while PHP's won't. Does that matter?
			if ( is_string( $kv->k ) && trim( $kv->k ) === $key ) {
				return $kv;
			}
		}

		return null;
	}

	/**
	 * Lookup a string key (first occurrence) in a KV array
	 * and return the value of the KV object
	 *
	 * @param array $kvs
	 * @param string $key
	 * @return mixed
	 */
	public static function lookup( array $kvs, $key ) {
		$kv = self::lookupKV( $kvs, $key );
		return $kv === null ? null : $kv->v;
	}
}
