<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Tokens;

use Wikimedia\Assert\Assert;
use Wikimedia\Assert\UnreachableException;

/**
 * Represents a preprocessor "piece".  Contents of this token are
 * *not* fully parsed, only the boundary locations are known.
 */
class PreprocTk extends Token {
	public const CONTENTS_ATTR = 'mw:contents';

	public function __construct(
		// should be an enum
		public PreprocType $type,
		SourceRange $tsr,
		/**
		 * @var KV Contents of this piece, not including the
		 * opening/closing delimiters.
		 */
		KV $contents,
		/**
		 * Number of repetitions of the open/close token.
		 */
		public int $count = 1,
	) {
		parent::__construct( null, null );
		$this->dataParsoid->tsr = $tsr;
		Assert::invariant(
			$contents->k === self::CONTENTS_ATTR,
			"KV must be " . self::CONTENTS_ATTR
		);
		$contents->srcOffsets ??=
			$type->shrinkRange( $tsr, $count )->expandTsrV();
		$this->attribs[] = $contents;
	}

	protected function recomputeTsr() {
		$this->dataParsoid->tsr = $this->type->growRange(
			$this->getContentsKV()->srcOffsets->value,
			$this->count
		);
	}

	/** @return list<PreprocTk|string> */
	public function getContents(): array {
		return $this->getAttributeV( self::CONTENTS_ATTR );
	}

	/** @return KV containing `list<PreprocTk|string>` as value */
	public function getContentsKV(): KV {
		return $this->getAttributeKV( self::CONTENTS_ATTR );
	}

	/**
	 * @param list<PreprocTk|string> $contents
	 * @param SourceRange $tsr
	 */
	public function setContents( array $contents, SourceRange $tsr ): void {
		$this->setContentsKV(
			// wikipeg caches KVs so don't mutate an existing KV.
			self::newContentsKV( $contents, $tsr )
		);
	}

	/**
	 * @param KV $contents
	 */
	public function setContentsKV( KV $contents ): void {
		Assert::invariant( $contents->k === self::CONTENTS_ATTR,
						  "not a contents KV" );
		Assert::invariant( $contents->srcOffsets !== null,
						  "missing KV srcOffsets" );
		foreach ( $this->attribs as &$attr ) {
			if ( $attr->k === self::CONTENTS_ATTR ) {
				$attr = $contents;
				return;
			}
		}
		throw new UnreachableException( "PreprocTk should always have contents" );
	}

	/**
	 * Helper: return a new contents KV.
	 * @param list<PreprocTk|string> $contents
	 * @param ?SourceRange $tsr
	 * @return KV with key set to `self::CONTENTS_ATTR` and given `$contents`
	 *  as value.
	 */
	public static function newContentsKV( array $contents, ?SourceRange $tsr ): KV {
		return new KV( self::CONTENTS_ATTR, $contents, $tsr?->expandTsrV() );
	}

	public function __clone() {
		parent::__clone();
		// No new non-primitive properties to clone.
	}

	/** @inheritDoc */
	#[\ReturnTypeWillChange]
	public function jsonSerialize() {
		return [
			'type' => $this->getType(),
			'open' => $this->type->open(),
			'count' => $this->count,
			'attribs' => $this->attribs,
			'dataParsoid' => $this->dataParsoid,
		];
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ) {
		return new self(
			PreprocType::fromOpen( $json['open'] ),
			$json['dataParsoid']->tsr,
			$json['attribs'][0],
			$json['count'],
		);
	}

	/**
	 * Return the string form of this PreprocTk; this should be *identical*
	 * to the original "preprocessed" wikitext.
	 */
	public function __toString(): string {
		return $this->print( false );
	}

	/**
	 * Pretty-print a PreprocTk token.
	 * @param bool $pretty if true (default) the output will be on multiple
	 *  lines.  If false, the string result should be identical to the
	 *  original "preprocessed" wikitext.
	 * @return string
	 */
	public function print( $pretty = true ): string {
		return self::printContents(
			self::newContentsKV( [ $this ], $this->dataParsoid->tsr ),
			$pretty
		);
	}

	/**
	 * Pretty-print a contents KV on multiple lines.
	 * @param KV $contents A contents KV containing a `list<string|PreprocTk>`
	 * @param bool $pretty if true (default) the output will be on multiple
	 *  lines.  If false, the string result should be identical to the
	 *  original "preprocessed" wikitext.
	 * @return string
	 */
	public static function printContents( $contents, bool $pretty = true ): string {
		$result = [];
		self::printContentsInternal( $result, $contents->v, '', $pretty );
		return implode( $pretty ? "\n" : '', $result );
	}

	/**
	 * @param list<string> &$result
	 * @param list<string|PreprocTk> $pieces A contents array
	 * @param string $prefix Indentation prefix
	 */
	protected static function printContentsInternal(
		array &$result, array $pieces, string $prefix, bool $pretty
	): void {
		foreach ( $pieces as $item ) {
			if ( is_string( $item ) ) {
				$result[] = $prefix .
					( $pretty ? json_encode( $item, JSON_UNESCAPED_SLASHES ) : $item );
			} else {
				$item->printInternal( $result, $prefix, $pretty );
			}
		}
	}

	/**
	 * Pretty-print this PreprocTk token.
	 * @param list<string> &$result An array of output lines.
	 * @param string $prefix Indentation prefix
	 */
	protected function printInternal( array &$result, string $prefix, bool $pretty ): void {
		$result[] = $prefix . str_repeat( $this->type->open(), $this->count );
		self::printContentsInternal(
			$result,
			$this->getContents(),
			$pretty ? ( $prefix . '  ' ) : '',
			$pretty
		);
		$result[] = $prefix . str_repeat( $this->type->close(), $this->count );
	}
}
