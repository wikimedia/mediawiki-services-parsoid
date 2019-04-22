<?php
declare( strict_types = 1 );

namespace Parsoid\Tokens;

/**
 * Represents a source offset range for key-value pair.
 */
class KVSourceOffset implements \JsonSerializable {

	/**
	 * Source offsets for the key.
	 * @var SourceOffset
	 */
	public $key;

	/**
	 * Source offsets for the value.
	 * @var SourceOffset
	 */
	public $value;

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
		$this->key = new SourceOffset( $keyStart, $keyEnd );
		$this->value = new SourceOffset( $valueStart, $valueEnd );
	}

	/**
	 * Return a new key-value source offset shifted by $amount.
	 * @param int $amount The amount to shift by
	 * @return KVSourceOffset
	 */
	public function offset( int $amount ): KVSourceOffset {
		return new KVSourceOffset(
			$this->key->start + $amount,
			$this->key->end + $amount,
			$this->value->start + $amount,
			$this->value->end + $amount
		);
	}

	/**
	 * Create a new key-value source offset range from an array of
	 * integers (such as created during JSON serialization).
	 * @param int[] $so
	 * @return KVSourceOffset
	 */
	public static function fromArray( array $so ): KVSourceOffset {
		return new KVSourceOffset( $so[0], $so[1], $so[2], $so[3] );
	}

	/**
	 * @inheritDoc
	 */
	public function jsonSerialize(): array {
		return [
			$this->key->start,
			$this->key->end,
			$this->value->start,
			$this->value->end,
		];
	}
}
