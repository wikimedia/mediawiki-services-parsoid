<?php
declare( strict_types = 1 );

namespace Parsoid\Tokens;

use Wikimedia\Assert\Assert;

/**
 * Represents a DOM source range.  That is, for a given DOM tree, gives
 * the source offset range in the original wikitext for this DOM tree,
 * as well as the opening and closing tag widths if appropriate.
 */
class DomSourceRange extends SourceRange {
	/**
	 * Opening tag width.
	 * @var int|null
	 */
	public $openWidth;

	/**
	 * Closing tag width.
	 * @var int|null
	 */
	public $closeWidth;

	/**
	 * Create a new DOM source offset.
	 * @param int|null $start The starting index (unicode code points, inclusive)
	 * @param int|null $end The ending index (unicode code points, exclusive)
	 * @param int|null $openWidth The width of the open container tag
	 * @param int|null $closeWidth The width of the close container tag
	 */
	public function __construct( ?int $start, ?int $end, ?int $openWidth, ?int $closeWidth ) {
		parent::__construct( $start, $end );
		$this->openWidth = $openWidth;
		$this->closeWidth = $closeWidth;
	}

	/**
	 * Return the substring of the given string corresponding to the
	 * inner portion of this range (that is, not including the opening
	 * and closing tag widths).
	 * @param string $str The source text string
	 * @return string
	 */
	public function innerSubstr( string $str ): string {
		return mb_substr( $str, $this->innerStart(), $this->innerLength() );
	}

	/**
	 * Return the "inner start", that is, the start offset plus the open width.
	 * @return int
	 */
	public function innerStart(): int {
		return $this->start + ( $this->openWidth ?? 0 );
	}

	/**
	 * Return the "inner end", that is, the end offset minus the close width.
	 * @return int
	 */
	public function innerEnd(): int {
		return $this->end - ( $this->closeWidth ?? 0 );
	}

	/**
	 * Return the length of this source range, excluding the open and close
	 * tag widths.
	 * @return int
	 */
	public function innerLength(): int {
		return $this->innerEnd() - $this->innerStart();
	}

	/**
	 * Return a new DOM source range shifted by $amount.
	 * @param int $amount The amount to shift by
	 * @return DomSourceRange
	 */
	public function offset( int $amount ): DomSourceRange {
		return new DomSourceRange(
			$this->start + $amount,
			$this->end + $amount,
			$this->openWidth,
			$this->closeWidth
		);
	}

	/**
	 * @return bool True if the tag widths are valid.
	 */
	public function hasValidTagWidths(): bool {
		return $this->openWidth !== null && $this->closeWidth !== null &&
			$this->openWidth >= 0 && $this->closeWidth >= 0;
	}

	/**
	 * Convert a TSR to a DSR with zero-width container open/close tags.
	 * @param SourceRange $tsr
	 * @return DomSourceRange
	 */
	public static function fromTsr( SourceRange $tsr ): DomSourceRange {
		return new DomSourceRange( $tsr->start, $tsr->end, null, null );
	}

	/**
	 * Create a new DomSourceRange from an array of integers/null (such as
	 * created during JSON serialization).
	 * @param array<int|null> $dsr
	 * @return DomSourceRange
	 */
	public static function fromArray( array $dsr ): DomSourceRange {
		Assert::invariant(
			count( $dsr ) === 2 || count( $dsr ) === 4,
			'Not enough elements in DSR array'
		);
		return new DomSourceRange(
			$dsr[0], $dsr[1], $dsr[2] ?? null, $dsr[3] ?? null
		);
	}

	/**
	 * @inheritDoc
	 */
	public function jsonSerialize(): array {
		return [ $this->start, $this->end, $this->openWidth, $this->closeWidth ];
	}
}
