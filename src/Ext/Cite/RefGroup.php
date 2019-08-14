<?php
declare( strict_types = 1 );

namespace Parsoid\Ext\Cite;

use DOMDocument;
use DOMElement;
use Parsoid\Config\Env;
use Parsoid\Utils\DOMDataUtils;
use Parsoid\Utils\DOMUtils;
use Parsoid\Utils\Title;
use stdClass;

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
	 * RefGroup constructor.
	 * @param string $group
	 */
	public function __construct( string $group = '' ) {
		$this->name = $group;
		$this->refs = [];
		$this->indexByName = [];
	}

	/**
	 * Generate leading linkbacks
	 * @param string $href
	 * @param string|null $group
	 * @param string $text
	 * @param DOMDocument $ownerDoc
	 * @param Env $env
	 * @return DOMElement
	 */
	private static function createLinkback(
		string $href, ?string $group, string $text, DOMDocument $ownerDoc, Env $env
	): DOMElement {
		$a = $ownerDoc->createElement( 'a' );
		$s = $ownerDoc->createElement( 'span' );
		$textNode = $ownerDoc->createTextNode( $text . ' ' );
		$title = Title::newFromText(
			$env->getPageConfig()->getTitle(),
			$env->getSiteConfig()
		);
		$a->setAttribute( 'href', $env->makeLink( $title ) . '#' . $href );
		$s->setAttribute( 'class', 'mw-linkback-text' );
		if ( $group ) {
			$a->setAttribute( 'data-mw-group', $group );
		}
		$s->appendChild( $textNode );
		$a->appendChild( $s );
		return $a;
	}

	/**
	 * @param Env $env
	 * @param DOMElement $refsList
	 * @param stdClass $ref
	 */
	public function renderLine( Env $env, DOMElement $refsList, stdClass $ref ): void {
		$ownerDoc = $refsList->ownerDocument;

		// Generate the li and set ref content first, so the HTML gets parsed.
		// We then append the rest of the ref nodes before the first node
		$li = $ownerDoc->createElement( 'li' );
		$refDir = $ref->dir;
		$refTarget = $ref->target;
		$refContent = $ref->content;
		$refGroup = $ref->group;
		DOMDataUtils::addAttributes( $li, [
				'about' => '#' . $refTarget,
				'id' => $refTarget,
				'class' => ( $refDir === 'rtl' || $refDir === 'ltr' ) ? 'mw-cite-dir-' . $refDir : null
			]
		);
		$reftextSpan = $ownerDoc->createElement( 'span' );
		DOMDataUtils::addAttributes(
			$reftextSpan,
			[
				'id' => 'mw-reference-text-' . $refTarget,
				'class' => 'mw-reference-text',
			]
		);
		if ( $refContent ) {
			$content = $env->getFragment( $refContent )[0];
			DOMUtils::migrateChildrenBetweenDocs( $content, $reftextSpan );
			DOMDataUtils::visitAndLoadDataAttribs( $reftextSpan );
		}
		$li->appendChild( $reftextSpan );

		if ( count( $ref->linkbacks ) === 1 ) {
			$linkback = self::createLinkback( $ref->id, $refGroup, "↑", $ownerDoc, $env );
			$linkback->setAttribute( 'rel', 'mw:referencedBy' );
			$li->insertBefore( $linkback, $reftextSpan );
		} else {
			// 'mw:referencedBy' span wrapper
			$span = $ownerDoc->createElement( 'span' );
			$span->setAttribute( 'rel', 'mw:referencedBy' );
			$li->insertBefore( $span, $reftextSpan );

			foreach ( $ref->linkbacks as $i => $lb ) {
				$span->appendChild(
					self::createLinkback( $lb, $refGroup, (string)( $i + 1 ), $ownerDoc, $env )
				);
			}
		}

		// Space before content node
		$li->insertBefore( $ownerDoc->createTextNode( ' ' ), $reftextSpan );

		// Add it to the ref list
		$refsList->appendChild( $li );
	}
}
