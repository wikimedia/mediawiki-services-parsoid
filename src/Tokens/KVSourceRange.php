<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Tokens;

use Wikimedia\Assert\Assert;
use Wikimedia\JsonCodec\JsonCodecable;
use Wikimedia\JsonCodec\JsonCodecableTrait;

/**
 * Represents a source offset range for a key-value pair.
 */
class KVSourceRange implements JsonCodecable {
	use JsonCodecableTrait;

	/**
	 * Source range for the key.
	 */
	public SourceRange $key;

	/**
	 * Source range for the value.
	 */
	public SourceRange $value;

	/**
	 * Create a new key-value source offset range.
	 * @param int $keyStart The start index of the key
	 *   (unicode code points, inclusive)
	 * @param int $keyEnd The end index of the key
	 *   (unicode code points, exclusive)
	 * @param int $valueStart The start index of the value
	 *   (unicode code points, inclusive)
	 * @param int $valueEnd The end index of the value
	 *   (unicode code points, exclusive)
	 */
	public function __construct( int $keyStart, int $keyEnd, int $valueStart, int $valueEnd ) {
		$this->key = new SourceRange( $keyStart, $keyEnd );
		$this->value = new SourceRange( $valueStart, $valueEnd );
	}

	public function __clone() {
		$this->key = clone $this->key;
		$this->value = clone $this->value;
	}

	/**
	 * Return a new key-value source offset range shifted by $amount.
	 * @param int $amount The amount to shift by
	 * @return KVSourceRange
	 */
	public function offset( int $amount ): KVSourceRange {
		return new KVSourceRange(
			$this->key->start + $amount,
			$this->key->end + $amount,
			$this->value->start + $amount,
			$this->value->end + $amount
		);
	}

	/**
	 * Return a new source range spanning both the key and value of
	 * this KVSourceRange.
	 */
	public function span(): SourceRange {
		return new SourceRange( $this->key->start, $this->value->end );
	}

	/**
	 * Create a new key-value source offset range from an array of
	 * integers (such as created during JSON serialization).
	 *
	 * @param int[] $json
	 *
	 * @return KVSourceRange
	 */
	public static function newFromJsonArray( array $json ): KVSourceRange {
		Assert::invariant(
			count( $json ) === 4,
			'Not enough elements in KVSourceRange array'
		);
		return new KVSourceRange( $json[0], $json[1], $json[2], $json[3] );
	}

	/**
	 * @inheritDoc
	 */
	public function toJsonArray(): array {
		return [
			$this->key->start,
			$this->key->end,
			$this->value->start,
			$this->value->end,
		];
	}
}
