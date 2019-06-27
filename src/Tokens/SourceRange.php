<?php
declare( strict_types = 1 );

namespace Parsoid\Tokens;

use Wikimedia\Assert\Assert;

/**
 * Represents a source offset range.
 */
class SourceRange implements \JsonSerializable {

	/**
	 * Offset of the first character (range start is inclusive).
	 * @var int|null
	 */
	public $start;

	/**
	 * Offset just past the last character (range end is exclusive).
	 * @var int|null
	 */
	public $end;

	/**
	 * Create a new source offset range.
	 * @param int|null $start The starting index (unicode code points, inclusive)
	 * @param int|null $end The ending index (unicode code points, exclusive)
	 */
	public function __construct( ?int $start, ?int $end ) {
		$this->start = $start;
		$this->end = $end;
	}

	/**
	 * Return a KVSourceRange where this SourceRange is the key,
	 * and the value has zero length.
	 * @return KVSourceRange
	 */
	public function expandTsrK(): KVSourceRange {
		return new KVSourceRange(
			$this->start, $this->end, $this->end, $this->end
		);
	}

	/**
	 * Return a KVSourceRange where this SourceRange is the value,
	 * and the key has zero length.
	 * @return KVSourceRange
	 */
	public function expandTsrV(): KVSourceRange {
		return new KVSourceRange(
			$this->start, $this->start, $this->start, $this->end
		);
	}

	/**
	 * Return a KVSourceRange by using this SourceRange for the key
	 * and the given SourceRange parameter for the value.
	 * @param SourceRange $value
	 * @return KVSourceRange
	 */
	public function join( SourceRange $value ): KVSourceRange {
		return new KVSourceRange(
			$this->start, $this->end, $value->start, $value->end
		);
	}

	/**
	 * Return the substring of the given string corresponding to this
	 * range.
	 * @param string $str The source text string
	 * @return string
	 */
	public function substr( string $str ): string {
		return mb_substr( $str, $this->start, $this->length() );
	}

	/**
	 * Temporary alternate of substr for use in the tokenizer, which already
	 * uses UTF-8 byte offsets.
	 * @param string $str The source text string
	 * @return string
	 */
	public function rawSubstr( string $str ): string {
		return substr( $str, $this->start, $this->length() );
	}

	/**
	 * Return a new source range shifted by $amount.
	 * @param int $amount The amount to shift by
	 * @return SourceRange
	 */
	public function offset( int $amount ): SourceRange {
		return new SourceRange( $this->start + $amount, $this->end + $amount );
	}

	/**
	 * Return the length of this source range.
	 * @return int
	 */
	public function length(): int {
		return $this->end - $this->start;
	}

	/**
	 * Create a new source offset range from an array of
	 * integers (such as created during JSON serialization).
	 * @param int[] $sr
	 * @return SourceRange
	 */
	public static function fromArray( array $sr ): SourceRange {
		Assert::invariant(
			count( $sr ) === 2,
			'Wrong # of elements in SourceRange array'
		);
		return new SourceRange( $sr[0], $sr[1] );
	}

	/**
	 * @inheritDoc
	 */
	public function jsonSerialize(): array {
		return [ $this->start, $this->end ];
	}
}
