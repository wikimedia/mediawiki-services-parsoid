<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Html2Wt\DOMHandlers;

use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Html2Wt\SerializerState;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\Utils;
use Wikimedia\Parsoid\Utils\WTUtils;

class MetaHandler extends DOMHandler {

	public function __construct() {
		parent::__construct( false );
	}

	/** @inheritDoc */
	public function handle(
		Element $node, SerializerState $state, bool $wrapperUnmodified = false
	): ?Node {
		$property = $node->getAttribute( 'property' ) ?? '';
		$dp = DOMDataUtils::getDataParsoid( $node );
		$dmw = DOMDataUtils::getDataMw( $node );

		if ( isset( $dp->src ) && DOMUtils::matchTypeOf( $node, '#^mw:Placeholder(/|$)#' ) ) {
			$this->emitPlaceholderSrc( $node, $state );
			return $node->nextSibling;
		}

		// Check for property before type so that page properties with
		// templated attrs roundtrip properly.
		// Ex: {{DEFAULTSORT:{{1x|foo}} }}
		if ( $property ) {
			preg_match( '#^mw\:PageProp/(.*)$#D', $property, $switchType );
			if ( $switchType ) {
				$out = $switchType[1];
				$cat = preg_match( '/^(?:category)?(.*)/', $out, $catMatch );
				if ( $cat && isset( Utils::magicMasqs()[$catMatch[1]] ) ) {
					$contentInfo = $state->serializer->serializedAttrVal( $node, 'content' );
					if ( WTUtils::hasExpandedAttrsType( $node ) ) {
						$out = '{{' . $contentInfo['value'] . '}}';
					} elseif ( isset( $dp->src ) ) {
						$colon = strpos( $dp->src, ':', 2 );
						$out = preg_replace( '/^([^:}]+).*$/D', "$1", $dp->src, 1 );
						if ( ( $colon === false ) && ( $contentInfo['value'] === '' ) ) {
							$out .= '}}';
						} else {
							$out .= ':' . $contentInfo['value'] . '}}';
						}
					} else {
						$magicWord = mb_strtoupper( $catMatch[1] );
						$out = '{{' . $magicWord . ':' . $contentInfo['value'] . '}}';
					}
				} else {
					$out = $state->getEnv()->getSiteConfig()->getMagicWordWT(
						$switchType[1], $dp->magicSrc ?? '' );
				}
				$state->emitChunk( $out, $node );
			} else {
				( new FallbackHTMLHandler )->handle( $node, $state );
			}
		} else {
			switch ( $node->getAttribute( 'typeof' ) ?? '' ) {
				case 'mw:Includes/IncludeOnly':
					// Remove the dp.src when older revisions of HTML expire in RESTBase
					$state->emitChunk( $dmw->src ?? $dp->src ?? '', $node );
					break;
				case 'mw:Includes/IncludeOnly/End':
					// Just ignore.
					break;
				case 'mw:Includes/NoInclude':
					$state->emitChunk( $dp->src ?? '<noinclude>', $node );
					break;
				case 'mw:Includes/NoInclude/End':
					$state->emitChunk( $dp->src ?? '</noinclude>', $node );
					break;
				case 'mw:Includes/OnlyInclude':
					$state->emitChunk( $dp->src ?? '<onlyinclude>', $node );
					break;
				case 'mw:Includes/OnlyInclude/End':
					$state->emitChunk( $dp->src ?? '</onlyinclude>', $node );
					break;
				case 'mw:DiffMarker/inserted':
				case 'mw:DiffMarker/deleted':
				case 'mw:DiffMarker/moved':
				case 'mw:Separator':
					// just ignore it
					break;
				default:
					( new FallbackHTMLHandler() )->handle( $node, $state );
			}
		}
		return $node->nextSibling;
	}

	/** @inheritDoc */
	public function before( Element $node, Node $otherNode, SerializerState $state ): array {
		$type = $node->getAttribute( 'typeof' ) ?: $node->getAttribute( 'property' ) ?:	null;
		if ( $type && str_contains( $type, 'mw:PageProp/categorydefaultsort' ) ) {
			if ( $otherNode instanceof Element
				&& DOMCompat::nodeName( $otherNode ) === 'p'
				&& ( DOMDataUtils::getDataParsoid( $otherNode )->stx ?? null ) !== 'html'
			) {
				// Since defaultsort is outside the p-tag, we need 2 newlines
				// to ensure that it go back into the p-tag when parsed.
				return [ 'min' => 2 ];
			} else {
				return [ 'min' => 1 ];
			}
		} elseif (
			WTUtils::isNewElt( $node )
			// Placeholder metas or <*include*> tags don't need to be serialized on their own line
			&& !DOMUtils::matchTypeOf( $node, '#^mw:(Placeholder|Includes)(/|$)#' )
		) {
			return [ 'min' => 1 ];
		} else {
			return [];
		}
	}

	/** @inheritDoc */
	public function after( Element $node, Node $otherNode, SerializerState $state ): array {
		// No diffs
		if (
			WTUtils::isNewElt( $node )
			// Placeholder metas or <*include*> tags don't need to be serialized on their own line
			&& !DOMUtils::matchTypeOf( $node, '#^mw:(Placeholder|Includes)(/|$)#' )
		) {
			return [ 'min' => 1 ];
		} else {
			return [];
		}
	}

}
