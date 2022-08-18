<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Html2Wt;

use Wikimedia\Assert\Assert;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\Html2Wt\ConstrainedText\LanguageVariantText;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\Utils;
use Wikimedia\Parsoid\Wikitext\Consts;

/**
 * Serializes language variant markup, like `-{ ... }-`.
 */
class LanguageVariantHandler {

	/**
	 * Expand a whitespace sequence.
	 * @see \Wikimedia\Parsoid\Wt2Html\TT\LanguageVariantHandler::compressSpArray
	 * @param list<int|string> $a
	 * @return list<string>
	 */
	private static function expandSpArray( array $a ): array {
		$result = [];
		foreach ( $a as $el ) {
			if ( is_int( $el ) ) {
				for ( $i = $el; $i--; ) {
					$result[] = '';
				}
			} else {
				$result[] = $el;
			}
		}
		return $result;
	}

	/**
	 * Helper function: serialize a DOM string
	 * @param SerializerState $state
	 * @param DocumentFragment $df
	 * @param ?array $opts
	 * @return string
	 */
	private static function ser( SerializerState $state, DocumentFragment $df, ?array $opts ) {
		$options =
			( $opts ?? [] ) + [
				'env' => $state->getEnv(),
				'onSOL' => false
			];
			return $state->serializer->domToWikitext( $options, $df );
	}

	/**
	 * Helper function: protect characters not allowed in language names
	 * @param string $l
	 * @return string
	 */
	private static function protectLang( string $l ): string {
		if ( preg_match( '/^[a-z][-a-zA-Z]+$/D', $l ) ) {
			return $l;
		}
		return '<nowiki>' . Utils::escapeWtEntities( $l ) . '</nowiki>';
	}

	/**
	 * Helper function: combine the three parts of the -{ }- string
	 * @param string $flagStr
	 * @param string $bodyStr
	 * @param string|bool $useTrailingSemi
	 * @return string
	 */
	private static function combine( string $flagStr, string $bodyStr, $useTrailingSemi ): string {
		if ( $flagStr !== '' || str_contains( $bodyStr, '|' ) ) {
			$flagStr .= '|';
		}
		if ( $useTrailingSemi !== false ) {
			$bodyStr .= ';' . $useTrailingSemi;
		}

		return $flagStr . $bodyStr;
	}

	/**
	 * Canonicalize combinations of flags.
	 * $originalFlags should be [ 'flag' => <integer position>, ... ]
	 * @param array<string,int> $originalFlags
	 * @param list<string> $flSp
	 * @param list<string> $flags
	 * @param bool $noFilter
	 * @param ?string $protectFunc
	 * @return string
	 */
	private static function sortedFlags(
		array $originalFlags, array $flSp, array $flags, bool $noFilter,
		?string $protectFunc
	): string {
		$filterInternal = static function ( string $f ) use ( $noFilter ): bool {
			// Filter out internal-use-only flags
			if ( $noFilter ) {
				return true;
			}
			return ( $f[0] ?? null ) !== '$';
		};
		$flags = array_filter( $flags, $filterInternal );

		$sortByOriginalPosition = static function ( string $a, string $b ) use ( $originalFlags ): int {
			$ai = $originalFlags[$a] ?? -1;
			$bi = $originalFlags[$b] ?? -1;
			return $ai - $bi;
		};
		usort( $flags, $sortByOriginalPosition );

		$insertOriginalWhitespace = static function ( string $f ) use ( $originalFlags, $protectFunc, $flSp ): string {
			// Reinsert the original whitespace around the flag (if any)
			$i = $originalFlags[$f] ?? null;
			if ( $protectFunc !== null ) {
				$p = self::$protectFunc( $f );
			} else {
				$p = $f;
			}
			if ( $i !== null && ( 2 * $i + 1 ) < count( $flSp ) ) {
				return $flSp[2 * $i] . $p . $flSp[2 * $i + 1];
			}
			return $p;
		};
		$flags = array_map( $insertOriginalWhitespace, $flags );
		$s = implode( ';', $flags );

		if ( 2 * count( $originalFlags ) + 1 === count( $flSp ) ) {
			if ( count( $flSp ) > 1 || strlen( $s ) ) {
				$s .= ';';
			}
			$s .= $flSp[2 * count( $originalFlags )];
		}
		return $s;
	}

	private static function maybeDeleteFlag(
		array $originalFlags, array &$flags, string $f
	): void {
		if ( !isset( $originalFlags[$f] ) ) {
			unset( $flags[$f] );
		}
	}

	/**
	 * LanguageVariantHandler
	 */
	public static function handleLanguageVariant( SerializerState $state, Element $node ): void {
		$dataMWV = DOMDataUtils::getDataMwVariant( $node );
		$dp = DOMDataUtils::getDataParsoid( $node );
		$flSp = self::expandSpArray( $dp->flSp ?? [] );
		$textSp = self::expandSpArray( $dp->tSp ?? [] );
		$trailingSemi = false;
		$flags = [];
		$originalFlags = [];
		if ( isset( $dp->fl ) ) {
			foreach ( $dp->fl as $key => $val ) {
				if ( !isset( $originalFlags[$key] ) ) {   // was $val
					$originalFlags[$val] = $key;
				}
			}
		}

		$result = '$E|'; // "error" flag

		foreach ( Consts::$LCNameMap as $name => $f ) {
			if ( $dataMWV->$name ?? false ) {
				$flags[$f] = true;
			}
		}

		// Tweak flag set to account for implicitly-enabled flags.
		if ( DOMUtils::nodeName( $node ) !== 'meta' ) {
			$flags['$S'] = true;
		}
		if ( !isset( $flags['$S'] ) && !isset( $flags['T'] ) && $dataMWV->filter === null ) {
			$flags['H'] = true;
		}
		if ( count( $flags ) === 1 && isset( $flags['$S'] ) ) {
			self::maybeDeleteFlag( $originalFlags, $flags, '$S' );
		} elseif ( isset( $flags['D'] ) ) {
			// Weird: Only way to hide a 'describe' rule is to write -{D;A|...}-
			if ( isset( $flags['$S'] ) ) {
				if ( isset( $flags['A'] ) ) {
					$flags['H'] = true;
				}
				unset( $flags['A'] );
			} else {
				$flags['A'] = true;
				unset( $flags['H'] );
			}
		} elseif ( isset( $flags['T'] ) ) {
			if ( isset( $flags['A'] ) && !isset( $flags['$S'] ) ) {
				unset( $flags['A'] );
				$flags['H'] = true;
			}
		} elseif ( isset( $flags['A'] ) ) {
			if ( isset( $flags['$S'] ) ) {
				self::maybeDeleteFlag( $originalFlags, $flags, '$S' );
			} elseif ( isset( $flags['H'] ) ) {
				self::maybeDeleteFlag( $originalFlags, $flags, 'A' );
			}
		} elseif ( isset( $flags['R'] ) ) {
			self::maybeDeleteFlag( $originalFlags, $flags, '$S' );
		} elseif ( isset( $flags['-'] ) ) {
			self::maybeDeleteFlag( $originalFlags, $flags, 'H' );
		}

		if ( $dataMWV?->filter?->langs !== null ) {
			// "Restrict possible variants to a limited set"
			$text = self::ser( $state, $dataMWV->filter->text, [ 'protect' => '/\}-/' ] );
			Assert::invariant( count( $flags ) === 0, 'Error in language variant flags' );
			$result = self::combine(
				self::sortedFlags(
					$originalFlags, $flSp, $dataMWV->filter->langs, true,
					'protectLang'
				),
				$text, false
			);
		} else { /* no trailing semi */
			if ( $dataMWV->disabled instanceof DocumentFragment ||
				 $dataMWV->name instanceof DocumentFragment ) {
				// "Raw" / protect contents from language converter
				$text = self::ser( $state, $dataMWV->disabled ?? $dataMWV->name,
					[ 'protect' => '/\}-/' ] );
				if ( !preg_match( '/[:;|]/', $text ) ) {
					self::maybeDeleteFlag( $originalFlags, $flags, 'R' );
				}
				$result = self::combine(
					self::sortedFlags(
						$originalFlags, $flSp, array_keys( $flags ), false, null
					),
					$text, false
				);
			} elseif ( $dataMWV->twoway !== null ) {
				// Two-way rules (most common)
				if ( count( $textSp ) % 3 === 1 ) {
					$trailingSemi = $textSp[count( $textSp ) - 1];
				}
				$b = isset( $dataMWV->twoway[0] ) && $dataMWV->twoway[0]->lang === '*' ?
					array_slice( $dataMWV->twoway, 0, 1 ) :
					$dataMWV->twoway ?? [];
				$text = implode( ';',
					array_map(
						function ( $rule, $idx ) use ( $state, $textSp, &$trailingSemi ) {
							$text = self::ser( $state, $rule->text, [ 'protect' => '/;|\}-/' ] );
							if ( $rule->lang === '*' ) {
								$trailingSemi = false;
								return $text;
							}
							$length = ( 3 * ( $idx + 1 ) ) - ( 3 * $idx );
							$ws = ( 3 * $idx + 2 < count( $textSp ) ) ?
							array_slice( $textSp, 3 * $idx, $length ) :
								[ ( $idx > 0 ) ? ' ' : '', '', '' ];
							return $ws[0] . self::protectLang( $rule->lang ) . $ws[1] . ':' . $ws[2] . $text;
						},
						$b,
						array_keys( $b )
					)
				);
				// suppress output of default flag ('S')
				self::maybeDeleteFlag( $originalFlags, $flags, '$S' );
				$result = self::combine(
					self::sortedFlags(
						$originalFlags, $flSp, array_keys( $flags ), false, null
					),
					$text, $trailingSemi
				);
			} elseif ( $dataMWV->oneway !== null ) {
				// One-way rules (uncommon)
				if ( count( $textSp ) % 4 === 1 ) {
					$trailingSemi = $textSp[count( $textSp ) - 1];
				}
				$text = implode( ';',
					array_map( function ( $rule, $idx ) use ( $state, $textSp ) {
							$from = self::ser( $state, $rule->from, [ 'protect' => '/:|;|=>|\}-/' ] );
							$to = self::ser( $state, $rule->to, [ 'protect' => '/;|\}-/' ] );
							$length = ( 4 * ( $idx + 1 ) ) - ( 4 * $idx );
							$ws = ( 4 * $idx + 3 < count( $textSp ) ) ?
								array_slice( $textSp, 4 * $idx, $length ) :
								[ '', '', '', '' ];
							return $ws[0] . $from . '=>' . $ws[1] . self::protectLang( $rule->lang ) .
								$ws[2] . ':' . $ws[3] . $to;
					}, $dataMWV->oneway, range( 0, count( $dataMWV->oneway ) - 1 )
					)
				);
				$result = self::combine(
					self::sortedFlags(
						$originalFlags, $flSp, array_keys( $flags ), false, null
					),
					$text, $trailingSemi
				);
			}
		}
		$state->emitChunk( new LanguageVariantText( '-{' . $result . '}-', $node ), $node );
	}

}
