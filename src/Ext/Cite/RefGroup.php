<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
namespace Parsoid;

$ParsoidExtApi = $module->parent->parent->parent->parent->require( './extapi.js' )->versionCheck( '^0.10.0' );
$temp0 = $ParsoidExtApi;
$DOMDataUtils = $temp0::DOMDataUtils;
$DOMUtils = $temp0::DOMUtils;

/**
 * Helper class used by `<references>` implementation.
 * @class
 */
class RefGroup {
	public function __construct( $group ) {
		$this->name = $group || '';
		$this->refs = [];
		$this->indexByName = new Map();
	}
	public $name;
	public $refs;
	public $indexByName;

	public function renderLine( $env, $refsList, $ref ) {
		$ownerDoc = $refsList->ownerDocument;

		// Generate the li and set ref content first, so the HTML gets parsed.
		// We then append the rest of the ref nodes before the first node
		$li = $ownerDoc->createElement( 'li' );
		DOMDataUtils::addAttributes( $li, [
				'about' => '#' . $ref->target,
				'id' => $ref->target,
				'class' => ( [ 'rtl', 'ltr' ]->includes( $ref->dir ) ) ? 'mw-cite-dir-' . $ref->dir : null
			]
		);
		$reftextSpan = $ownerDoc->createElement( 'span' );
		DOMDataUtils::addAttributes( $reftextSpan, [
				'id' => 'mw-reference-text-' . $ref->target,
				'class' => 'mw-reference-text'
			]
		);
		if ( $ref->content ) {
			$content = $env->fragmentMap->get( $ref->content )[ 0 ];
			DOMUtils::migrateChildrenBetweenDocs( $content, $reftextSpan );
			DOMDataUtils::visitAndLoadDataAttribs( $reftextSpan );
		}
		$li->appendChild( $reftextSpan );

		// Generate leading linkbacks
		$createLinkback = function ( $href, $group, $text ) use ( &$ownerDoc, &$env ) {
			$a = $ownerDoc->createElement( 'a' );
			$s = $ownerDoc->createElement( 'span' );
			$textNode = $ownerDoc->createTextNode( $text . ' ' );
			$a->setAttribute( 'href', $env->page->titleURI . '#' . $href );
			$s->setAttribute( 'class', 'mw-linkback-text' );
			if ( $group ) {
				$a->setAttribute( 'data-mw-group', $group );
			}
			$s->appendChild( $textNode );
			$a->appendChild( $s );
			return $a;
		};
		if ( count( $ref->linkbacks ) === 1 ) {
			$linkback = $createLinkback( $ref->id, $ref->group, "↑" );
			$linkback->setAttribute( 'rel', 'mw:referencedBy' );
			$li->insertBefore( $linkback, $reftextSpan );
		} else {
			// 'mw:referencedBy' span wrapper
			$span = $ownerDoc->createElement( 'span' );
			$span->setAttribute( 'rel', 'mw:referencedBy' );
			$li->insertBefore( $span, $reftextSpan );

			$ref->linkbacks->forEach( function ( $lb, $i ) use ( &$span, &$createLinkback, &$ref ) {
					$span->appendChild( $createLinkback( $lb, $ref->group, $i + 1 ) );
			}
			);
		}

		// Space before content node
		$li->insertBefore( $ownerDoc->createTextNode( ' ' ), $reftextSpan );

		// Add it to the ref list
		$refsList->appendChild( $li );
	}
}

$module->exports = $RefGroup;
