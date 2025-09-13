<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TT;

use Wikimedia\Parsoid\Core\DomSourceRange;
use Wikimedia\Parsoid\Ext\Arguments;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Fragments\WikitextPFragment;
use Wikimedia\Parsoid\Tokens\KV;
use Wikimedia\Parsoid\Tokens\PreprocTk;

/**
 * An implementation of the Arguments interface used by TemplateHandler
 * to invoke PFragmentHandlers.
 *
 * @unstable This may change further as named-argument support (T390344)
 *  is developed.
 */
class TemplateHandlerArguments implements Arguments {

	public function __construct(
		/** @var list<KV> Where keys and values are list<string|PreprocTk> */
		private array $args
	) {
	}

	/** @inheritDoc */
	public function getOrderedArgs(
		ParsoidExtensionAPI $extApi,
		$expandAndTrim = true
	): array {
		// The ordered arg array squashes the key and value together.
		$result = [];
		foreach ( $this->args as $kv ) {
			$spread = self::checkSpread( $extApi, $kv );
			if ( $spread ) {
				foreach ( $spread->getOrderedArgs( $extApi, false ) as $v ) {
					$i = count( $result );
					$shouldExpand = is_array( $expandAndTrim ) ?
						( $expandAndTrim[$i] ?? true ) : $expandAndTrim;
					if ( $shouldExpand ) {
						$v = $v->expand( $extApi )->trim();
					}
					$result[] = $v;
				}
				continue;
			}
			$i = count( $result );
			$shouldExpand = is_array( $expandAndTrim ) ?
				( $expandAndTrim[$i] ?? true ) : $expandAndTrim;
			$tsr = $kv->srcOffsets->span();
			$v = self::stringify( $kv->v );
			if ( self::isNamed( $kv ) ) {
				$v = self::stringify( $kv->k ) . "=$v";
			}
			$v = WikitextPFragment::newFromWt(
				$v, DomSourceRange::fromTsr( $tsr )
			);
			if ( $shouldExpand ) {
				$v = $v->expand( $extApi )->trim();
			}
			$result[] = $v;
		}
		return $result;
	}

	/** @inheritDoc */
	public function getNamedArgs(
		ParsoidExtensionAPI $extApi,
		$expandAndTrim = true
	): array {
		$unnamedIdx = 1;
		$result = [];
		foreach ( $this->args as $kv ) {
			$spread = self::checkSpread( $extApi, $kv );
			if ( $spread ) {
				$spreadArgs = $spread->getNamedArgs( $extApi, false );
				// Treat numeric keys as "unnamed" and renumber
				for ( $i = 1; isset( $spreadArgs[$i] ); $i++ ) {
					$key = strval( $unnamedIdx++ );
					$v = $spreadArgs[$i];
					$shouldExpand = is_array( $expandAndTrim ) ?
						( $expandAndTrim[$key] ?? true ) : $expandAndTrim;
					if ( $shouldExpand ) {
						$v = $v->expand( $extApi )->trim();
					}
					$result[$key] = $v;
				}
				foreach ( $spreadArgs as $key => $v ) {
					if ( preg_match( '/^[1-9][0-9]*$/D', (string)$key ) &&
						intval( $key ) < $i ) {
						// We already processed this key as "unnamed"
						continue;
					}
					$shouldExpand = is_array( $expandAndTrim ) ?
						( $expandAndTrim[$key] ?? true ) : $expandAndTrim;
					if ( $shouldExpand ) {
						$v = $v->expand( $extApi )->trim();
					}
					$result[$key] = $v;
				}
				continue;
			}
			if ( self::isNamed( $kv ) ) {
				$key = WikitextPFragment::newFromWt(
					self::stringify( $kv->k ),
					DomSourceRange::fromTsr( $kv->srcOffsets->key )
				)->expand( $extApi )->trim()->killMarkers();
			} else {
				$key = strval( $unnamedIdx++ );
			}
			$shouldExpand = is_array( $expandAndTrim ) ?
					( $expandAndTrim[$key] ?? true ) :
					$expandAndTrim;
			$v = WikitextPFragment::newFromWt(
				self::stringify( $kv->v ),
				DomSourceRange::fromTsr( $kv->srcOffsets->value )
			);
			if ( $shouldExpand ) {
				$v = $v->expand( $extApi )->trim();
			}
			// Note that (by design) this may overwrite earlier values
			// for the same key.  Rightmost argument wins.
			$result[$key] = $v;
		}
		return $result;
	}

	/**
	 * Check to see if the key for this named argument is `...` and the
	 * expanded value is an instanceof `Arguments`.  If so, return the
	 * Arguments; otherwise return null.
	 */
	private static function checkSpread( ParsoidExtensionAPI $extApi, KV $kv ): ?Arguments {
		if ( !self::isNamed( $kv ) ) {
			return null;
		}
		$k = self::stringify( $kv->k );
		if ( trim( $k ) !== '...' ) {
			return null;
		}
		$v = WikitextPFragment::newFromWt(
			self::stringify( $kv->v ),
			DomSourceRange::fromTsr( $kv->srcOffsets->value )
		)->expand( $extApi )->trim();
		if ( $v instanceof Arguments ) {
			return $v;
		}
		// Return an empty arguments array, so this isn't interpreted
		// as a named or positional argument
		return new class implements Arguments {
			/** @inheritDoc */
			public function getOrderedArgs(
				ParsoidExtensionAPI $extApi,
				$expandAndTrim = true
			): array {
				return [];
			}

			/** @inheritDoc */
			public function getNamedArgs(
				ParsoidExtensionAPI $extApi,
				$expandAndTrim = true
			): array {
				return [];
			}
		};
	}

	/**
	 * @return true if the given KV represents a named argument.
	 */
	private static function isNamed( KV $kv ): bool {
		return $kv->srcOffsets->key->end !== $kv->srcOffsets->value->start;
	}

	/**
	 * Convert the preprocessed contents back into the original wikitext.
	 * @param list<string|PreprocTk> $contents
	 * @return string
	 */
	private static function stringify( array $contents ): string {
		return PreprocTk::printContents(
			PreprocTk::newContentsKV( $contents, null ), false
		);
	}
}
