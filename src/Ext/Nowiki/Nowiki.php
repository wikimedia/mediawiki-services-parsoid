<?php
declare( strict_types = 1 );

namespace Parsoid\Ext\Nowiki;

use DOMDocument;
use DOMElement;
use Parsoid\Ext\ExtensionTag;
use Parsoid\Ext\SerialHandler;
use Parsoid\Html2Wt\SerializerState;
use Parsoid\Utils\DOMCompat;
use Parsoid\Utils\DOMDataUtils;
use Parsoid\Utils\DOMUtils;
use Parsoid\Utils\Util;
use Parsoid\Utils\WTUtils;
use Parsoid\Wt2Html\TT\ParserState;

/**
 * Nowiki treats anything inside it as plain text.
 */
class Nowiki implements ExtensionTag, SerialHandler {

	/** @inheritDoc */
	public function toDOM( ParserState $state, string $txt, array $extArgs ): DOMDocument {
		$doc = $state->env->createDocument();
		$span = $doc->createElement( 'span' );
		$span->setAttribute( 'typeof', 'mw:Nowiki' );

		foreach ( preg_split( '/(&[#0-9a-zA-Z]+;)/', $txt, -1, PREG_SPLIT_DELIM_CAPTURE ) as $i => $t ) {
			if ( $i % 2 === 1 ) {
				$cc = Util::decodeWtEntities( $t );
				if ( $cc !== $t ) {
					// This should match the output of the "htmlentity" rule
					// in the tokenizer.
					$entity = $doc->createElement( 'span' );
					$entity->setAttribute( 'typeof', 'mw:Entity' );
					DOMDataUtils::setDataParsoid( $entity, (object)[
						'src' => $t,
						'srcContent' => $cc,
					] );
					$entity->appendChild( $doc->createTextNode( $cc ) );
					$span->appendChild( $entity );
					continue;
				}
				// else, fall down there
			}
			$span->appendChild( $doc->createTextNode( $t ) );
		}

		$span->normalize();
		DOMCompat::getBody( $doc )->appendChild( $span );
		return $doc;
	}

	/** @inheritDoc */
	public function handle( DOMElement $node, SerializerState $state, bool $wrapperUnmodified ): void {
		if ( !$node->hasChildNodes() ) {
			$state->hasSelfClosingNowikis = true;
			$state->emitChunk( '<nowiki/>', $node );
			return;
		}
		$state->emitChunk( '<nowiki>', $node );
		for ( $child = $node->firstChild;  $child;  $child = $child->nextSibling ) {
			if ( DOMUtils::isElt( $child ) ) {
				'@phan-var DOMElement $child';/** @var DOMElement $child */
				if ( DOMUtils::isDiffMarker( $child ) ) {
					/* ignore */
				} elseif ( $child->nodeName === 'span'
					 && $child->getAttribute( 'typeof' ) === 'mw:Entity'
				) {
					$state->serializer->serializeNode( $child );
				} else {
					$state->emitChunk( DOMCompat::getOuterHTML( $child ), $node );
				}
			} elseif ( DOMUtils::isText( $child ) ) {
				$state->emitChunk( WTUtils::escapeNowikiTags( $child->nodeValue ), $child );
			} else {
				$state->serializer->serializeNode( $child );
			}
		}
		$state->emitChunk( '</nowiki>', $node );
	}

	/** @return array */
	public function getConfig(): array {
		return [
			'tags' => [
				[
					'name' => 'nowiki',
					// FIXME: handle() will also be called on type mw:Extension/nowiki
					'class' => self::class,
				]
			]
		];
	}

}
