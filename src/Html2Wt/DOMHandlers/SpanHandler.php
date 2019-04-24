<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
namespace Parsoid;

use Parsoid\DOMUtils as DOMUtils;
use Parsoid\DOMDataUtils as DOMDataUtils;
use Parsoid\Util as Util;
use Parsoid\WTSUtils as WTSUtils;

use Parsoid\DOMHandler as DOMHandler;
use Parsoid\FallbackHTMLHandler as FallbackHTMLHandler;

class SpanHandler extends DOMHandler {
	public function __construct() {
		parent::__construct( false );
		$this->genContentSpanTypes = new Set( [
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
				'mw:Placeholder'
			]
		);
	}
	public $genContentSpanTypes;

	public function handleG( $node, $state, $wrapperUnmodified ) {
		$env = $state->env;
		$dp = DOMDataUtils::getDataParsoid( $node );
		$type = $node->getAttribute( 'typeof' ) || '';
		$contentSrc = $node->textContent || $node->innerHTML;
		if ( $this->isRecognizedSpanWrapper( $type ) ) {
			if ( $type === 'mw:Nowiki' ) {
				$nativeExt = $env->conf->wiki->extConfig->tags->get( 'nowiki' );
				/* await */ $nativeExt->serialHandler->handle( $node, $state, $wrapperUnmodified );
			} elseif ( preg_match( '/(?:^|\s)mw:(?:Image|Video|Audio)(\/(Frame|Frameless|Thumb))?/', $type ) ) {
				// TODO: Remove when 1.5.0 content is deprecated,
				// since we no longer emit media in spans.  See the test,
				// "Serialize simple image with span wrapper"
				/* await */ $state->serializer->figureHandler( $node );
			} elseif ( preg_match( '/(?:^|\s)mw\:Entity/', $type ) && DOMUtils::hasNChildren( $node, 1 ) ) {
				// handle a new mw:Entity (not handled by selser) by
				// serializing its children
				if ( $dp->src !== null && $contentSrc === $dp->srcContent ) {
					$state->serializer->emitWikitext( $dp->src, $node );
				} elseif ( DOMUtils::isText( $node->firstChild ) ) {
					$state->emitChunk(
						Util::entityEncodeAll( $node->firstChild->nodeValue ),
						$node->firstChild
					);
				} else {
					/* await */ $state->serializeChildren( $node );
				}
			} elseif ( preg_match( '/(^|\s)mw:Placeholder(\/\w*)?/', $type ) ) {
				if ( $dp->src !== null ) {
					return $this->emitPlaceholderSrc( $node, $state );
				} elseif ( /* RegExp */ '/(^|\s)mw:Placeholder(\s|$)/'
&& DOMUtils::hasNChildren( $node, 1 )
&& DOMUtils::isText( $node->firstChild )
&& // See the DisplaySpace hack in the urltext rule
						// in the tokenizer.
						preg_match( '/\u00a0+/', $node->firstChild->nodeValue )
				) {
					$state->emitChunk(
						' '->repeat( strlen( ' ' ) ),
						$node->firstChild
					);
				} else {
					/* await */ FallbackHTMLHandler::handler( $node, $state );
				}
			}
		} else {
			$kvs = WTSUtils::getAttributeKVArray( $node )->filter( function ( $kv ) use ( &$DOMDataUtils ) {
					return !preg_match( '/^data-parsoid/', $kv->k )
&& ( $kv->k !== DOMDataUtils\DataObjectAttrName() )
&& !( $kv->k === 'id' && preg_match( '/^mw[\w-]{2,}$/', $kv->v ) );
			}
			);
			if ( !$state->rtTestMode && $dp->misnested && $dp->stx !== 'html'
&& !count( $kvs )
			) {
				// Discard span wrappers added to flag misnested content.
				// Warn since selser should have reused source.
				$env->log( 'warn', 'Serializing misnested content: ' . $node->outerHTML );
				/* await */ $state->serializeChildren( $node );
			} else {
				// Fall back to plain HTML serialization for spans created
				// by the editor.
				/* await */ FallbackHTMLHandler::handler( $node, $state );
			}
		}
	}

	public function isRecognizedSpanWrapper( $type ) {
		return $type && preg_split( '/\s+/', $type )->find( function ( $t ) {
					return $this->genContentSpanTypes->has( $t );
		}
			) !== null;
	}
}

$module->exports = $SpanHandler;
