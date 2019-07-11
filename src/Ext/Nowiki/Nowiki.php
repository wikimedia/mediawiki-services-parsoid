<?php
declare( strict_types = 1 );

namespace Parsoid\Ext\Nowiki;

use DOMDocument;
use DOMElement;
use DOMText;
use Parsoid\Config\ParsoidExtensionAPI;
use Parsoid\Ext\Extension;
use Parsoid\Ext\ExtensionTag;
use Parsoid\Html2Wt\SerializerState;
use Parsoid\Utils\DOMCompat;
use Parsoid\Utils\DOMDataUtils;
use Parsoid\Utils\DOMUtils;
use Parsoid\Utils\Util;
use Parsoid\Utils\WTUtils;
use Wikimedia\Assert\Assert;

/**
 * Nowiki treats anything inside it as plain text.
 */
class Nowiki extends ExtensionTag implements Extension {

	/** @inheritDoc */
	public function toDOM( ParsoidExtensionAPI $extApi, string $txt, array $extArgs ): DOMDocument {
		$doc = $extApi->getEnv()->createDocument();
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
	public function fromHTML(
		DOMElement $node, SerializerState $state, bool $wrapperUnmodified
	): string {
		if ( !$node->hasChildNodes() ) {
			$state->hasSelfClosingNowikis = true;
			return '<nowiki/>';
		}
		$str = '<nowiki>';
		for ( $child = $node->firstChild;  $child;  $child = $child->nextSibling ) {
			$out = null;
			if ( $child instanceof DOMElement ) {
				if ( DOMUtils::isDiffMarker( $child ) ) {
					/* ignore */
				} elseif ( $child->nodeName === 'span' &&
					 $child->getAttribute( 'typeof' ) === 'mw:Entity' &&
					DOMUtils::hasNChildren( $child, 1 )
				) {
					$dp = DOMDataUtils::getDataParsoid( $child );
					if ( isset( $dp->src ) && $dp->srcContent === $child->textContent ) {
						// Unedited content
						$out = $dp->src;
					} else {
						// Edited content
						$out = Util::entityEncodeAll( $child->firstChild->nodeValue );
					}
				} else {
					/* This is a hacky fallback for what is essentially
					 * undefined behavior. No matter what we emit here,
					 * this won't roundtrip html2html. */
					$state->getEnv()->log( 'error/html2wt/nowiki', 'Invalid nowiki content' );
					$out = $child->textContent;
				}
			} elseif ( $child instanceof DOMText ) {
				$out = $child->nodeValue;
			} else {
				Assert::invariant( DOMUtils::isComment( $child ), "Expected a comment here" );
				/* Comments can't be embedded in a <nowiki> */
				$state->getEnv()->log( 'error/html2wt/nowiki',
					'Discarded invalid embedded comment in a <nowiki>' );
				$out = '';
			}

			// Always escape any nowikis found in out
			if ( $out ) {
				$str .= WTUtils::escapeNowikiTags( $out );
			}
		}

		return $str . '</nowiki>';
	}

	/** @inheritDoc */
	public function getConfig(): array {
		return [
			'tags' => [
				[
					'name' => 'nowiki',
					'class' => self::class,
				]
			]
		];
	}

}
