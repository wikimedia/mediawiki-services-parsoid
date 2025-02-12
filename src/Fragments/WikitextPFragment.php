<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Fragments;

use Wikimedia\JsonCodec\Hint;
use Wikimedia\Parsoid\Core\DomSourceRange;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Utils\Utils;

/**
 * A non-atomic fragment comprised of a wikitext string and a strip state.
 *
 * The wikitext string may contain strip markers, which are
 * placeholders corresponding to other atomic fragments.  The internal
 * StripState holds the mapping between placeholders and the
 * corresponding atomic fragments.
 *
 * WikitextPFragments are not atomic, and so a WikitextPFragment
 * should never contain strip markers corresponding to other
 * WikitextPFragments.
 */
class WikitextPFragment extends PFragment {

	public const TYPE_HINT = 'wt';

	/** Wikitext value of this fragment, with embedded strip markers. */
	private string $value;

	/** The strip state giving the value of the embedded strip markers. */
	private ?StripState $stripState;

	private function __construct(
		string $value, ?DomSourceRange $srcOffsets, ?StripState $stripState
	) {
		parent::__construct( $srcOffsets );
		$this->value = $value;
		$this->stripState = $stripState;
	}

	/**
	 * Return a new WikitextPFragment consisting of the given fragment
	 * of wikitext, and an optional source string for it.
	 */
	public static function newFromWt( string $wikitext, ?DomSourceRange $srcOffsets ): WikitextPFragment {
		return new self( $wikitext, $srcOffsets, null );
	}

	/**
	 * Return a new WikitextPFragment consisting of the given array of
	 * pieces concatenated together.  Each piece can contain either
	 * a `string` of wikitext (without strip markers) or a PFragment.
	 * @param array<string|PFragment> $pieces
	 */
	public static function newFromSplitWt( array $pieces, ?DomSourceRange $srcOffsets = null ): WikitextPFragment {
		// T386233: Temporarily disable <nowiki/> insertion
		$disableNowiki = true;

		$wikitext = [];
		$isFirst = true;
		$lastIsMarker = false;
		$firstDSR = null;
		$lastDSR = null;
		$ss = StripState::new();
		foreach ( $pieces as $p ) {
			if ( $p instanceof PFragment && !$p->isAtomic() ) {
				// Don't create a strip marker for non-atomic fragments,
				// instead concatenate their wikitext components
				$p = self::castFromPFragment( $p );
			}
			if ( $p === '' ) {
				continue;
			} elseif ( $p instanceof PFragment && $p->isEmpty() ) {
				continue;
			} elseif ( $p instanceof WikitextPFragment ) {
				// XXX we could also avoid adding the <nowiki> if we notice
				// that our source ranges are adjacent (ie, the wikitext
				// strings were adjacent in the source document)
				if ( !( $isFirst || $lastIsMarker || $p->startsWithMarker() ) ) {
					if ( !$disableNowiki ) {
						$wikitext[] = '<nowiki/>';
					}
				}
				$wikitext[] = $p->value;
				if ( $p->stripState !== null ) {
					$ss->addAllFrom( $p->stripState );
				}
				if ( $isFirst ) {
					$firstDSR = $p->getSrcOffsets();
				}
				$lastIsMarker = $p->endsWithMarker();
				$lastDSR = $p->getSrcOffsets();
			} elseif ( !is_string( $p ) ) {
				// This is an atomic PFragment
				$wikitext[] = $ss->addWtItem( $p );
				if ( $isFirst ) {
					$firstDSR = $p->getSrcOffsets();
				}
				$lastIsMarker = true;
				$lastDSR = $p->getSrcOffsets();
			} else {
				// This is a wikitext string
				if ( !( $isFirst || $lastIsMarker ) ) {
					if ( !$disableNowiki ) {
						$wikitext[] = '<nowiki/>';
					}
				}
				$wikitext[] = $p;
				$lastIsMarker = false;
				$lastDSR = null;
			}
			$isFirst = false;
		}
		return new self(
			implode( '', $wikitext ),
			// Create DSR if first and last pieces were fragments.
			$srcOffsets ?? self::joinSourceRange( $firstDSR, $lastDSR ),
			$ss->isEmpty() ? null : $ss
		);
	}

	/**
	 * Returns a new WikitextPFragment from the given literal string
	 * and optional source offsets.
	 *
	 * Unlike LiteralStringPFragment, the resulting fragment is
	 * non-atomic -- it will not be an opaque strip marked but instead
	 * will consists of escaped wikitext that will evaluate to the
	 * desired string value.
	 *
	 * @see LiteralStringPFragment::newFromLiteral() for an atomic
	 *  fragment equivalent.
	 *
	 * @param string $value The literal string
	 * @param ?DomSourceRange $srcOffsets The source range corresponding to
	 *   this literal string, if there is one
	 */
	public static function newFromLiteral( string $value, ?DomSourceRange $srcOffsets ): WikitextPFragment {
		return self::newFromWt( Utils::escapeWt( $value ), $srcOffsets );
	}

	/**
	 * Return a WikitextPFragment corresponding to the given PFragment.
	 * If the fragment is not already a WikitextPFragment, this will convert
	 * it using PFragment::asMarkedWikitext().
	 */
	public static function castFromPFragment( PFragment $fragment ): WikitextPFragment {
		if ( $fragment instanceof WikitextPFragment ) {
			return $fragment;
		}
		$ss = StripState::new();
		$wikitext = $fragment->asMarkedWikitext( $ss );
		return new self(
			$wikitext, $fragment->srcOffsets, $ss->isEmpty() ? null : $ss
		);
	}

	/** @inheritDoc */
	public function isEmpty(): bool {
		return $this->value === '';
	}

	/** @return false */
	public function isAtomic(): bool {
		return false;
	}

	/** @inheritDoc */
	public function asDom( ParsoidExtensionAPI $ext, bool $release = false ): DocumentFragment {
		return $ext->wikitextToDOM( $this, [], true );
	}

	/** @inheritDoc */
	public function asMarkedWikitext( StripState $stripState ): string {
		if ( $this->stripState !== null ) {
			$stripState->addAllFrom( $this->stripState );
		}
		return $this->value;
	}

	private function startsWithMarker(): bool {
		return StripState::startsWithStripMarker( $this->value );
	}

	private function endsWithMarker(): bool {
		return StripState::endsWithStripMarker( $this->value );
	}

	/**
	 * Split this fragment at its strip markers and return an array
	 * which alternates between string items and PFragment items.
	 * The first and last items are guaranteed to be strings, and the
	 * array length is guaranteed to be odd and at least 1.
	 * @return list<string|PFragment>
	 */
	public function split(): array {
		if ( $this->stripState === null ) {
			return [ $this->value ];
		}
		return $this->stripState->splitWt( $this->value );
	}

	/**
	 * Trim leading and trailing whitespace from this fragment.
	 *
	 * If the result is just a strip marker, will return the fragment
	 * corresponding to that strip marker; that is, this method is
	 * not guaranteed to return a WikitextPFragment.
	 *
	 * @return PFragment
	 */
	public function trim(): PFragment {
		$pieces = $this->split();

		$oldSize = strlen( $pieces[0] );
		$pieces[0] = ltrim( $pieces[0] );
		$startTrim = $oldSize - strlen( $pieces[0] );

		$end = count( $pieces ) - 1;
		$oldSize = strlen( $pieces[$end] );
		$pieces[$end] = rtrim( $pieces[$end] );
		$endTrim = $oldSize - strlen( $pieces[$end] );

		$newDsr = null;
		if ( $this->srcOffsets !== null ) {
			[ $start, $end ] = [ $this->srcOffsets->start, $this->srcOffsets->end ];
			if ( $start !== null ) {
				$start += $startTrim;
			}
			if ( $end !== null ) {
				$end -= $endTrim;
			}
			$newDsr = new DomSourceRange( $start, $end, null, null );
		}
		return PFragment::fromSplitWt( $pieces, $newDsr );
	}

	/**
	 * Return a WikitextPFragment representing the concatenation of
	 * the given fragments, as wikitext.
	 */
	public static function concat( PFragment ...$fragments ): self {
		return self::newFromSplitWt( $fragments );
	}

	// JsonCodecable implementation

	/** @inheritDoc */
	public function toJsonArray(): array {
		$pieces = $this->split();
		if ( count( $pieces ) === 1 ) {
			$wt = $pieces[0];
			$ret = [
				self::TYPE_HINT => $wt,
			];
		} else {
			$ret = [
				self::TYPE_HINT => $pieces,
			];
		}
		return $ret + parent::toJsonArray();
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ): self {
		$v = $json[self::TYPE_HINT];
		if ( is_string( $v ) ) {
			$v = [ $v ];
		}
		return self::newFromSplitWt( $v, $json['dsr'] ?? null );
	}

	/** @inheritDoc */
	public static function jsonClassHintFor( string $keyName ) {
		if ( $keyName === self::TYPE_HINT ) {
			return Hint::build( PFragment::class, Hint::INHERITED, Hint::LIST );
		}
		return parent::jsonClassHintFor( $keyName );
	}
}
