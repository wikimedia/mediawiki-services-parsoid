<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Tokens;

use Wikimedia\Assert\Assert;
use Wikimedia\JsonCodec\Hint;
use Wikimedia\JsonCodec\JsonCodecable;
use Wikimedia\JsonCodec\JsonCodecableTrait;
use Wikimedia\Parsoid\Core\Source;
use Wikimedia\Parsoid\Utils\PHPUtils;

/**
 * Represents a source offset range.
 */
class SourceRange implements JsonCodecable {
	use JsonCodecableTrait;

	/**
	 * Offset of the first character (range start is inclusive).
	 * @var ?int
	 */
	public $start;

	/**
	 * Offset just past the last character (range end is exclusive).
	 * @var ?int
	 */
	public $end;

	/**
	 * The "source text" for this range.
	 *
	 * Optional for now because (a) we're retrofitting this into existing
	 * code, and (b) we don't have a way to serialize this yet so in
	 * html2wt contexts this will typically be null (T405759).
	 */
	public ?Source $source;

	/**
	 * Create a new source offset range.
	 * @param ?int $start The starting index (UTF-8 byte count, inclusive)
	 * @param ?int $end The ending index (UTF-8 byte count, exclusive)
	 * @param ?Source $source
	 */
	public function __construct( ?int $start, ?int $end, ?Source $source = null ) {
		$this->start = $start;
		$this->end = $end;
		$this->source = $source;
	}

	/**
	 * Return a KVSourceRange where this SourceRange is the key,
	 * and the value has zero length.
	 * @return KVSourceRange
	 */
	public function expandTsrK(): KVSourceRange {
		return new KVSourceRange(
			$this->start, $this->end, $this->end, $this->end,
			$this->source, $this->source
		);
	}

	/**
	 * Return a KVSourceRange where this SourceRange is the value,
	 * and the key has zero length.
	 * @return KVSourceRange
	 */
	public function expandTsrV(): KVSourceRange {
		return new KVSourceRange(
			$this->start, $this->start, $this->start, $this->end,
			$this->source, $this->source
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
			$this->start, $this->end, $value->start, $value->end,
			$this->source, $value->source,
		);
	}

	/**
	 * Return the substring of the given string corresponding to this
	 * range.
	 * @param string|Source ...$str The source text string (optional)
	 *  The Source of this object (if non-null) is preferred over the given
	 *  argument.
	 * @return string
	 */
	public function substr( string|Source ...$str ): string {
		$str = $this->getSourceString( $str );
		$start = $this->start;
		$length = $this->length();
		Assert::invariant( ( $start ?? -1 ) >= 0, "Bad SourceRange start" );
		// @phan-suppress-next-line PhanCoalescingNeverNull
		Assert::invariant( ( $length ?? -1 ) >= 0, "Bad SourceRange length" );
		return PHPUtils::safeSubstr( $str, $start, $length );
	}

	/**
	 * Helper function to turn an optional string|Source argument into
	 * a source string.
	 * @param array{0:string|Source} $args
	 * @return string
	 */
	protected function getSourceString( array $args ): string {
		// If a string is provided, use that -- in the tokenizer for
		// instance we're operating with a TSR offset so we can't use
		// the Source (until later, after the TSR is shifted)
		if ( is_string( $args[0] ?? null ) ) {
			return $args[0];
		}
		// Prefer own our Source, which is presumed to be more accurate
		// than whatever "get frame source" thing is providing the argument
		$source = $this->source ?? $args[0] ?? null;
		Assert::invariant( $source !== null, "Missing TSR/DSR source" );
		return $source->getSrcText();
	}

	/**
	 * Return a new source range shifted by $amount.
	 * @param int $amount The amount to shift by
	 * @return SourceRange
	 */
	public function offset( int $amount ): SourceRange {
		return new SourceRange( $this->start + $amount, $this->end + $amount, $this->source );
	}

	/**
	 * Return a range from the end of this range to the start of the given
	 * range.
	 * @param SourceRange $sr
	 * @return SourceRange
	 */
	public function to( SourceRange $sr ): SourceRange {
		return new SourceRange( $this->end, $sr->start, $this->source );
	}

	/**
	 * Return the length of this source range.
	 * @return int
	 */
	public function length(): int {
		return $this->end - $this->start;
	}

	/**
	 * Create a new SourceRange spanning the given Source.
	 */
	public static function fromSource( Source $source ): static {
		return new SourceRange( 0, strlen( $source->getSrcText() ), $source );
	}

	/** @inheritDoc */
	public function toJsonArray(): array {
		return [ $this->start, $this->end ];
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ): SourceRange {
		Assert::invariant(
			count( $json ) === 2,
			'Wrong # of elements in SourceRange array'
		);
		return new SourceRange( $json[0], $json[1] );
	}

	/** JsonCodec serialization hint. */
	public static function hint(): Hint {
		return Hint::build( self::class, Hint::USE_SQUARE );
	}
}
