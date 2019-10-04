<?php
declare( strict_types = 1 );

namespace Parsoid\Html2Wt\DOMHandlers;

use DOMElement;
use DOMNode;
use Parsoid\Html2Wt\SerializerState;
use Parsoid\Html2Wt\WTSUtils;
use Parsoid\Tokens\KV;
use Parsoid\Utils\DOMCompat;
use Parsoid\Utils\DOMDataUtils;
use Parsoid\Utils\DOMUtils;
use Parsoid\Utils\Util;

class SpanHandler extends DOMHandler {

	/** @var string[] List of typeof attributes to consider */
	public static $genContentSpanTypes = [
		'mw:Nowiki',
		'mw:Image',
		'mw:Image/Frameless',
		'mw:Image/Frame',
		'mw:Image/Thumb',
		'mw:Video',
		'mw:Video/Frameless',
		'mw:Video/Frame',
		'mw:Video/Thumb',
		'mw:Audio',
		'mw:Audio/Frameless',
		'mw:Audio/Frame',
		'mw:Audio/Thumb',
		'mw:Entity',
		'mw:Placeholder',
	];

	public function __construct() {
		parent::__construct( false );
	}

	/** @inheritDoc */
	public function handle(
		DOMElement $node, SerializerState $state, bool $wrapperUnmodified = false
	): ?DOMNode {
		$env = $state->getEnv();
		$dp = DOMDataUtils::getDataParsoid( $node );
		$type = $node->getAttribute( 'typeof' ) ?: '';
		$contentSrc = ( $node->textContent != '' ) ? $node->textContent
			: DOMCompat::getInnerHTML( $node );
		if ( $this->isRecognizedSpanWrapper( $type ) ) {
			if ( $type === 'mw:Nowiki' ) {
				$ext = $env->getSiteConfig()->getNativeExtTagImpl( 'nowiki' );
				$src = $ext->fromHTML( $node, $state, $wrapperUnmodified );
				$state->serializer->emitWikitext( $src, $node );
			} elseif ( preg_match( '#(?:^|\s)mw:(?:Image|Video|Audio)(/(Frame|Frameless|Thumb))?#',
				$type )
			) {
				// TODO: Remove when 1.5.0 content is deprecated,
				// since we no longer emit media in spans.  See the test,
				// "Serialize simple image with span wrapper"
				$state->serializer->figureHandler( $node );
			} elseif ( preg_match( '/(?:^|\s)mw:Entity/', $type ) && DOMUtils::hasNChildren( $node, 1 ) ) {
				// handle a new mw:Entity (not handled by selser) by
				// serializing its children
				if ( isset( $dp->src ) && $contentSrc === ( $dp->srcContent ?? null ) ) {
					$state->serializer->emitWikitext( $dp->src, $node );
				} elseif ( DOMUtils::isText( $node->firstChild ) ) {
					$state->emitChunk(
						Util::entityEncodeAll( $node->firstChild->nodeValue ),
						$node->firstChild );
				} else {
					$state->serializeChildren( $node );
				}
			} elseif ( preg_match( '#(^|\s)mw:Placeholder(/\w*)?#', $type ) ) {
				if ( isset( $dp->src ) ) {
					$this->emitPlaceholderSrc( $node, $state );
					return $node->nextSibling;
				} elseif (
					preg_match( '/(^|\s)mw:Placeholder(\s|$)/D', $type )
					&& DOMUtils::hasNChildren( $node, 1 )
					&& DOMUtils::isText( $node->firstChild )
					// See the DisplaySpace hack in the urltext rule in the tokenizer.
					&& preg_match( '/^\x{00a0}+$/uD', $node->firstChild->nodeValue )
				) {
					$state->emitChunk(
						// FIXME: Not sure why we even use a str_repeat instead of using ' ' (T197879)
						str_repeat( ' ', mb_strlen( $node->firstChild->nodeValue ) ),
						$node->firstChild
					);
				} else {
					( new FallbackHTMLHandler )->handle( $node, $state );
				}
			}
		} else {
			$kvs = array_filter( WTSUtils::getAttributeKVArray( $node ), function ( KV $kv ) {
				return !preg_match( '/^data-parsoid/', $kv->k )
					&& ( $kv->k !== DOMDataUtils::DATA_OBJECT_ATTR_NAME )
					&& !( $kv->k === 'id' && preg_match( '/^mw[\w-]{2,}$/D', $kv->v ) );
			} );
			if ( !$state->rtTestMode && !empty( $dp->misnested ) && ( $dp->stx ?? null ) !== 'html'
				&& !count( $kvs )
			) {
				// Discard span wrappers added to flag misnested content.
				// Warn since selser should have reused source.
				$env->log( 'warn', 'Serializing misnested content: ' . DOMCompat::getOuterHTML( $node ) );
				$state->serializeChildren( $node );
			} else {
				// Fall back to plain HTML serialization for spans created
				// by the editor.
				( new FallbackHTMLHandler )->handle( $node, $state );
			}
		}
		return $node->nextSibling;
	}

	private function isRecognizedSpanWrapper( string $type ): bool {
		$types = preg_split( '/\s+/', $type, -1, PREG_SPLIT_NO_EMPTY );
		return (bool)array_intersect( $types, self::$genContentSpanTypes );
	}

}
