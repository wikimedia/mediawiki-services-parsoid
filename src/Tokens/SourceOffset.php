<?php
declare( strict_types = 1 );

namespace Parsoid\Tokens;

/**
 * Represents a source offset range.
 */
class SourceOffset implements \JsonSerializable {

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
	 * Return a KVSourceOffset where this SourceOffset is the key,
	 * and the value has zero length.
	 * @return KVSourceOffset
	 */
	public function expandTsrK(): KVSourceOffset {
		return new KVSourceOffset(
			$this->start, $this->end, $this->end, $this->end
		);
	}

	/**
	 * Return a KVSourceOffset where this SourceOffset is the value,
	 * and the key has zero length.
	 * @return KVSourceOffset
	 */
	public function expandTsrV(): KVSourceOffset {
		return new KVSourceOffset(
			$this->start, $this->start, $this->start, $this->end
		);
	}

	/**
	 * Return a KVSourceOffsets by using this SourceOffset for the key
	 * and the given parameter for the value.
	 * @param SourceOffset $value
	 * @return KVSourceOffset
	 */
	public function join( SourceOffset $value ): KVSourceOffset {
		return new KVSourceOffset(
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
	 * Return a new source offset shifted by $amount.
	 * @param int $amount The amount to shift by
	 * @return SourceOffset
	 */
	public function offset( int $amount ): SourceOffset {
		return new SourceOffset( $this->start + $amount, $this->end + $amount );
	}

	/**
	 * Return the length of this source range.
	 * @return int
	 */
	public function length(): int {
		return $this->end - $this->start;
	}

	/**
	 * @inheritDoc
	 */
	public function jsonSerialize(): array {
		return [ $this->start, $this->end ];
	}
}
