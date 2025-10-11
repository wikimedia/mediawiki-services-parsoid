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

	/**
	 * Trim whitespace from both sides of a contents KV.
	 */
	public static function trimContentsKV( KV $contents ): KV {
		$start = 0;
		$end = count( $contents->v );
		$startTrim = 0;
		$endTrim = 0;
		// Trim off completely empty strings from both sizes
		while ( $start < $end && is_string( $contents->v[$start] ) && ltrim( $contents->v[$start] ) === '' ) {
			$startTrim += strlen( $contents->v[$start] );
			$start += 1;
		}
		while ( $start < $end && is_string( $contents->v[$end - 1] ) && rtrim( $contents->v[$end - 1] ) === '' ) {
			$endTrim += strlen( $contents->v[$end - 1] );
			$end -= 1;
		}
		$pieces = array_slice( $contents->v, $start, $end - $start );
		$end = count( $pieces );
		// Now trim leading whitespace from first element...
		if ( count( $pieces ) > 0 && is_string( $pieces[0] ) ) {
			$oldSize = strlen( $pieces[0] );
			$pieces[0] = ltrim( $pieces[0] );
			$startTrim += ( $oldSize - strlen( $pieces[0] ) );
		}
		// ...and trailing whitespace from last element.
		if ( count( $pieces ) > 0 && is_string( $pieces[$end - 1] ) ) {
			$oldSize = strlen( $pieces[$end - 1] );
			$pieces[$end - 1] = rtrim( $pieces[$end - 1] );
			$endTrim += ( $oldSize - strlen( $pieces[$end - 1] ) );
		}
		// Adjust TSR.
		$newTsr = $contents->srcOffsets?->value;
		if ( $newTsr !== null && !( $startTrim === 0 && $endTrim === 0 ) ) {
			[ $start, $end ] = [ $newTsr->start, $newTsr->end ];
			if ( $start !== null ) {
				$start += $startTrim;
			}
			if ( $end !== null ) {
				$end -= $endTrim;
			}
			$newTsr = new SourceRange( $start, $end, $newTsr->source );
		}
		return self::newContentsKV( $pieces, $newTsr );
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
	 * Split a contents KV by a string or a function.
	 * @param string|list<string>|callable(string,int):array $sep Either a
	 *   separator string, or a list of separator alternatives, or else a
	 *   function compatible with `preg_split` with the
	 *   PREG_SPLIT_DELIM_CAPTURE flag; that is, returns a list of
	 *   strings with the "splitter" string in odd indexes.
	 * @param KV $contents A contents KV, containing a `list<string|PreprocTk>`
	 * @param int $limit A split limit, or -1 for "no limit"
	 *   This is the *number of splits* permitted; the return array length
	 *   will be `1 + 2*$limit`.
	 * @return list<KV> a list of contents KVs, with the "splitter"
	 *   strings in odd indexes.
	 */
	public static function splitContentsBy(
		string|array|callable $sep,
		KV $contents,
		int $limit = -1
	): array {
		if ( is_string( $sep ) ) {
			$sep = [ $sep ];
		}
		if ( is_array( $sep ) ) {
			$sep = array_map( static fn ( $s )=>preg_quote( $s, '/' ), $sep );
			// Create a splitter function from the given string.
			$patt = '/(' . implode( '|', $sep ) . ')/';
			// PHP's accounting of split limit is "number of elements in the
			// result array, not counting the delimiters we capture", with
			// the result that it appears off-by-one compared to our definition
			$func = static fn ( $item, $limit ) =>
				preg_split( $patt, $item, 1 + $limit, PREG_SPLIT_DELIM_CAPTURE )
				?: [ $item ];
		} else {
			$func = $sep;
		}
		$result = [];
		$start = $contents->srcOffsets->value->start;
		$source = $contents->srcOffsets->value->source;
		// @phan-suppress-next-line PhanTypeSuspiciousNonTraversableForeach
		foreach ( $contents->v as $item ) {
			if ( $item instanceof PreprocTk ) {
				$sr = $item->dataParsoid->tsr;
				$newItems = [
					self::newContentsKV( [ $item ], $sr )
				];
				$start = $sr->end;
				$source = $sr->source;
			} else {
				$splitResult = [ $item ];
				if ( $limit === -1 || $limit > 0 ) {
					$splitResult = $func( $item, $limit );
				}
				// Adjust limit
				if ( $limit > 0 ) {
					$limit -= ( count( $splitResult ) - 1 ) / 2;
				}
				// Convert all the strings to KVs.
				$newItems = [];
				foreach ( $splitResult as $piece ) {
					$sr = new SourceRange( $start, $start + strlen( $piece ), $source );
					$newItems[] = self::newContentsKV( [ $piece ], $sr );
					$start = $sr->end;
				}
			}
			// If necessary, merge first of new items with last of result
			if ( $result ) {
				[ $last, $first ] = [ array_pop( $result ), $newItems[0] ];
				$sr = new SourceRange(
					$last->srcOffsets->value->start,
					$first->srcOffsets->value->end,
					$last->srcOffsets->value->source
				);
				// To avoid O(N^2) append, mutate last KV in-place.
				// (All KVs in $result were created inside this function.)
				// @phan-suppress-next-line PhanTypeSuspiciousNonTraversableForeach
				foreach ( $first->v as $v ) {
					// Don't add needless array entries for ''
					if ( $v !== '' ) {
						if ( $last->v === [ '' ] ) {
							$last->v = [ $v ];
						} else {
							$last->v[] = $v;
						}
					}
				}
				$last->srcOffsets = $sr->expandTsrV();
				$newItems[0] = $last;
			}
			array_push( $result, ...$newItems );
		}
		// Ensure there's at least one element in the result
		if ( count( $result ) === 0 ) {
			$result[] = self::newContentsKV( [], $contents->srcOffsets->value );
		}
		return $result;
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
