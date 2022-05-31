<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Core;

use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\WTUtils;
use Wikimedia\Parsoid\Wikitext\Consts;

/**
 * All media should have a fixed structure:
 *
 * ```
 * <conatinerElt>
 *  <linkElt><mediaElt /></linkElt>
 *  <captionElt>...</captionElt>
 * </containerElt>
 * ```
 *
 * Pull out this fixed structure, being as generous as possible with
 * possibly-broken HTML.
 */
class MediaStructure {

	/**
	 * Node names: figure, span
	 *
	 * @var ?Element
	 */
	 public $containerElt;

	/**
	 * Node names: a, span
	 *
	 * @var ?Element
	 */
	public $linkElt;

	/**
	 * Node names: img, audio, video, span
	 *
	 * @var ?Element
	 */
	public $mediaElt;

	/**
	 * Node names: figcaption
	 *
	 * @var ?Element
	 */
	public $captionElt;

	/**
	 * @param Element $mediaElt
	 * @param ?Element $linkElt
	 * @param ?Element $containerElt
	 */
	public function __construct(
		Element $mediaElt, ?Element $linkElt = null,
		?Element $containerElt = null
	) {
		$this->mediaElt = $mediaElt;
		$this->linkElt = $linkElt;
		$this->containerElt = $containerElt;
		if ( $containerElt && DOMCompat::nodeName( $containerElt ) === 'figure' ) {
			// FIXME: Support last child, which is not the linkElt, as the caption?
			$this->captionElt = DOMCompat::querySelector( $containerElt, 'figcaption' );
		}
	}

	/**
	 * We were not able to fetch info for the title, so the media was
	 * considered missing and rendered as a span.
	 *
	 * @return bool
	 */
	public function isRedLink(): bool {
		return ( DOMCompat::nodeName( $this->mediaElt ) === 'span' );
	}

	/**
	 * @return bool
	 */
	public function hasResource(): bool {
		return $this->mediaElt->hasAttribute( 'resource' );
	}

	/**
	 * @return string
	 */
	public function getResource(): string {
		return $this->mediaElt->getAttribute( 'resource' ) ?? '';
	}

	/**
	 * @return bool
	 */
	public function hasAlt(): bool {
		return $this->mediaElt->hasAttribute( 'alt' );
	}

	/**
	 * @return string
	 */
	public function getAlt(): string {
		return $this->mediaElt->getAttribute( 'alt' ) ?? '';
	}

	/**
	 * @return bool
	 */
	public function hasMediaUrl(): bool {
		return $this->linkElt && $this->linkElt->hasAttribute( 'href' );
	}

	/**
	 * @return string
	 */
	public function getMediaUrl(): string {
		return $this->linkElt ? ( $this->linkElt->getAttribute( 'href' ) ?? '' ) : '';
	}

	/**
	 * @param Node $node
	 * @return ?MediaStructure
	 */
	public static function parse( Node $node ): ?MediaStructure {
		if ( !WTUtils::isGeneratedFigure( $node ) ) {
			return null;
		}
		'@phan-var Element $node';  // @var Element $node
		$linkElt = $node;
		do {
			// Try being lenient, maybe there was a content model violation when
			// parsing and an active formatting element was reopened in the wrapper
			$linkElt = DOMUtils::firstNonSepChild( $linkElt );
		} while (
			$linkElt instanceof Element && DOMCompat::nodeName( $linkElt ) !== 'a' &&
			isset( Consts::$HTML['FormattingTags'][DOMCompat::nodeName( $linkElt )] )
		);
		if (
			!( $linkElt instanceof Element &&
				in_array( DOMCompat::nodeName( $linkElt ), [ 'a', 'span' ], true ) )
		) {
			if ( $linkElt instanceof Element ) {
				// Try being lenient, maybe this is the media element and we don't
				// have a link elt.  See the test, "Image: from basic HTML (1)"
				$mediaElt = $linkElt;
				$linkElt = null;
			} else {
				return null;
			}
		} else {
			$mediaElt = DOMUtils::firstNonSepChild( $linkElt );
		}
		if (
			!( $mediaElt instanceof Element &&
				in_array( DOMCompat::nodeName( $mediaElt ), [ 'audio', 'img', 'span', 'video' ], true ) )
		) {
			return null;
		}
		return new MediaStructure( $mediaElt, $linkElt, $node );
	}

}
