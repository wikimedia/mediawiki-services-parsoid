<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext\Cite;

use stdClass;
use Wikimedia\Parsoid\DOM\Document;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\Ext\DOMUtils;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Utils\DOMCompat;

/**
 * Helper class used by `<references>` implementation.
 */
class RefGroup {

	/**
	 * @var string
	 */
	public $name;

	/**
	 * @var stdClass[]
	 */
	public $refs;

	/**
	 * @var stdClass[]
	 */
	public $indexByName;

	/**
	 * @param string $group
	 */
	public function __construct( string $group = '' ) {
		$this->name = $group;
		$this->refs = [];
		$this->indexByName = [];
	}

	/**
	 * Generate leading linkbacks
	 * @param ParsoidExtensionAPI $extApi
	 * @param string $href
	 * @param ?string $group
	 * @param string $text
	 * @param Document $ownerDoc
	 * @return Element
	 */
	private static function createLinkback(
		ParsoidExtensionAPI $extApi, string $href, ?string $group,
		string $text, Document $ownerDoc
	): Element {
		$a = $ownerDoc->createElement( 'a' );
		$s = $ownerDoc->createElement( 'span' );
		$textNode = $ownerDoc->createTextNode( $text . ' ' );
		$a->setAttribute( 'href', $extApi->getPageUri() . '#' . $href );
		$s->setAttribute( 'class', 'mw-linkback-text' );
		if ( $group ) {
			$a->setAttribute( 'data-mw-group', $group );
		}
		$s->appendChild( $textNode );
		$a->appendChild( $s );
		return $a;
	}

	/**
	 * @param ParsoidExtensionAPI $extApi
	 * @param Element $refsList
	 * @param stdClass $ref
	 */
	public function renderLine(
		ParsoidExtensionAPI $extApi, Element $refsList, stdClass $ref
	): void {
		$ownerDoc = $refsList->ownerDocument;

		// Generate the li and set ref content first, so the HTML gets parsed.
		// We then append the rest of the ref nodes before the first node
		$li = $ownerDoc->createElement( 'li' );
		$refDir = $ref->dir;
		$refTarget = $ref->target;
		$refContentId = $ref->contentId;
		$refGroup = $ref->group;
		DOMUtils::addAttributes( $li, [
				'about' => '#' . $refTarget,
				'id' => $refTarget,
				'class' => ( $refDir === 'rtl' || $refDir === 'ltr' ) ? 'mw-cite-dir-' . $refDir : null
			]
		);
		$reftextSpan = $ownerDoc->createElement( 'span' );
		DOMUtils::addAttributes(
			$reftextSpan,
			[
				'id' => 'mw-reference-text-' . $refTarget,
				'class' => 'mw-reference-text',
			]
		);
		if ( $refContentId ) {
			// `sup` is the wrapper created by Ref::sourceToDom()'s call to
			// `extApi->extTagToDOM()`.  Only its contents are relevant.
			$sup = $extApi->getContentDOM( $refContentId )->firstChild;
			DOMUtils::migrateChildren( $sup, $reftextSpan );
			'@phan-var Element $sup';  /** @var Element $sup */
			DOMCompat::remove( $sup );
			$extApi->clearContentDOM( $refContentId );
		}
		$li->appendChild( $reftextSpan );

		if ( count( $ref->linkbacks ) === 1 ) {
			$linkback = self::createLinkback( $extApi, $ref->id, $refGroup, "↑", $ownerDoc );
			$linkback->setAttribute( 'rel', 'mw:referencedBy' );
			$li->insertBefore( $linkback, $reftextSpan );
		} else {
			// 'mw:referencedBy' span wrapper
			$span = $ownerDoc->createElement( 'span' );
			$span->setAttribute( 'rel', 'mw:referencedBy' );
			$li->insertBefore( $span, $reftextSpan );

			foreach ( $ref->linkbacks as $i => $lb ) {
				$span->appendChild(
					self::createLinkback( $extApi, $lb, $refGroup, (string)( $i + 1 ), $ownerDoc )
				);
			}
		}

		// Space before content node
		$li->insertBefore( $ownerDoc->createTextNode( ' ' ), $reftextSpan );

		// Add it to the ref list
		$refsList->appendChild( $li );
	}
}
