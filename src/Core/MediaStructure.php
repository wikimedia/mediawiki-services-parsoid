<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Core;

use DOMElement;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\WTUtils;

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
	 * @var ?DOMElement
	 */
	 public $containerElt;

	/**
	 * Node names: a, span
	 *
	 * @var ?DOMElement
	 */
	public $linkElt;

	/**
	 * Node names: img, audio, video, span
	 *
	 * @var ?DOMElement
	 */
	public $mediaElt;

	/**
	 * Node names: figcaption
	 *
	 * @var ?DOMElement
	 */
	public $captionElt;

	/**
	 * @param DOMElement $mediaElt
	 * @param ?DOMElement $linkElt
	 * @param ?DOMElement $containerElt
	 */
	public function __construct(
		DOMElement $mediaElt, ?DOMElement $linkElt = null,
		?DOMElement $containerElt = null
	) {
		$this->mediaElt = $mediaElt;
		$this->linkElt = $linkElt;
		$this->containerElt = $containerElt;
		if ( $containerElt && $containerElt->nodeName === 'figure' ) {
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
		return ( $this->mediaElt->nodeName === 'span' );
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
		return $this->mediaElt->getAttribute( 'resource' );
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
		return $this->mediaElt->getAttribute( 'alt' );
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
		return $this->linkElt ? $this->linkElt->getAttribute( 'href' ) : '';
	}

	/**
	 * @param \DOMNode $node
	 * @return ?MediaStructure
	 */
	public static function parse( \DOMNode $node ): ?MediaStructure {
		if ( !WTUtils::isGeneratedFigure( $node ) ) {
			return null;
		}
		'@phan-var DOMElement $node';  // @var DOMElement $node
		$linkElt = DOMUtils::firstNonSepChild( $node );
		if (
			!( $linkElt instanceof DOMElement &&
				in_array( $linkElt->nodeName, [ 'a', 'span' ], true ) )
		) {
			if ( $linkElt instanceof DOMElement ) {
				// Try being lenient, maybe this is media element and we don't
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
			!( $mediaElt instanceof DOMElement &&
				in_array( $mediaElt->nodeName, [ 'audio', 'img', 'span', 'video' ], true ) )
		) {
			return null;
		}
		return new MediaStructure( $mediaElt, $linkElt, $node );
	}

}
