<?php
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * Nowiki treats anything inside it as plain text.
 * @module ext/Nowiki
 */

namespace Parsoid;

use Parsoid\domino as domino;

$ParsoidExtApi = $module->parent->require( './extapi.js' )->versionCheck( '^0.10.0' );

$temp0 = $ParsoidExtApi;
$Promise = $temp0::Promise;
$Util = $temp0::Util;
$DOMUtils = $temp0::DOMUtils;
$WTUtils = $temp0::WTUtils;
$DOMDataUtils = $temp0::DOMDataUtils;

$toDOM = Promise::method( function ( $state, $txt, $extArgs ) use ( &$domino, &$Util, &$DOMDataUtils ) {
		$doc = domino::createDocument();
		$span = $doc->createElement( 'span' );
		$span->setAttribute( 'typeof', 'mw:Nowiki' );

		preg_split( '/(&[#0-9a-zA-Z]+;)/', $txt )->forEach( function ( $t, $i ) use ( &$Util, &$doc, &$DOMDataUtils, &$span ) {
				if ( $i % 2 === 1 ) {
					$cc = Util::decodeWtEntities( $t );
					if ( count( $cc ) < 3 ) {
						// This should match the output of the "htmlentity" rule
						// in the tokenizer.
						$entity = $doc->createElement( 'span' );
						$entity->setAttribute( 'typeof', 'mw:Entity' );
						DOMDataUtils::setDataParsoid( $entity, [
								'src' => $t,
								'srcContent' => $cc
							]
						);
						$entity->appendChild( $doc->createTextNode( $cc ) );
						$span->appendChild( $entity );
						return;
					}
					// else, fall down there
				}
				$span->appendChild( $doc->createTextNode( $t ) );
		}
		);

		$span->normalize();
		$doc->body->appendChild( $span );
		return $doc;
}
);

$serialHandler = [
	'handle' => /* async */function ( $node, $state, $wrapperUnmodified ) use ( &$DOMUtils, &$WTUtils ) {
		if ( !$node->hasChildNodes() ) {
			$state->hasSelfClosingNowikis = true;
			$state->emitChunk( '<nowiki/>', $node );
			return;
		}
		$state->emitChunk( '<nowiki>', $node );
		for ( $child = $node->firstChild;  $child;  $child = $child->nextSibling ) {
			if ( DOMUtils::isElt( $child ) ) {
				if ( DOMUtils::isDiffMarker( $child ) ) {

					/* ignore */
				} else { /* ignore */
				if ( $child->nodeName === 'SPAN'
&& $child->getAttribute( 'typeof' ) === 'mw:Entity'
				) {
					/* await */ $state->serializer->_serializeNode( $child );
				} else {
					$state->emitChunk( $child->outerHTML, $node );
				}
				}
			} elseif ( DOMUtils::isText( $child ) ) {
				$state->emitChunk( WTUtils::escapeNowikiTags( $child->nodeValue ), $child );
			} else {
				/* await */ $state->serializer->_serializeNode( $child );
			}
		}
		$state->emitChunk( '</nowiki>', $node );
	}

];

$module->exports = function () use ( &$toDOM, &$serialHandler ) {
	$this->config = [
		'tags' => [
			[
				'name' => 'nowiki',
				'toDOM' => $toDOM,
				// FIXME: This'll also be called on type mw:Extension/nowiki
				'serialHandler' => $serialHandler
			]
		]
	];
};
