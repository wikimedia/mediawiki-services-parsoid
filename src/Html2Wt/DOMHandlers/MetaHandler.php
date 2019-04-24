<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
namespace Parsoid;

use Parsoid\DOMDataUtils as DOMDataUtils;
use Parsoid\Util as Util;
use Parsoid\WTUtils as WTUtils;

use Parsoid\DOMHandler as DOMHandler;
use Parsoid\FallbackHTMLHandler as FallbackHTMLHandler;

class MetaHandler extends DOMHandler {
	public function __construct() {
		parent::__construct( false );
	}
	public function handleG( $node, $state, $wrapperUnmodified ) {
		$type = $node->getAttribute( 'typeof' ) || '';
		$property = $node->getAttribute( 'property' ) || '';
		$dp = DOMDataUtils::getDataParsoid( $node );
		$dmw = DOMDataUtils::getDataMw( $node );

		if ( $dp->src !== null
&& preg_match( '/(^|\s)mw:Placeholder(\/\w*)?$/', $type )
		) {
			return $this->emitPlaceholderSrc( $node, $state );
		}

		// Check for property before type so that page properties with
		// templated attrs roundtrip properly.
		// Ex: {{DEFAULTSORT:{{echo|foo}} }}
		if ( $property ) {
			$switchType = preg_match( '/^mw\:PageProp\/(.*)$/', $property );
			if ( $switchType ) {
				$out = $switchType[ 1 ];
				$cat = preg_match( '/^(?:category)?(.*)/', $out );
				if ( $cat && Util::magicMasqs::has( $cat[ 1 ] ) ) {
					$contentInfo =
					/* await */ $state->serializer->serializedAttrVal(
						$node, 'content', []
					);
					if ( WTUtils::hasExpandedAttrsType( $node ) ) {
						$out = '{{' . $contentInfo->value . '}}';
					} elseif ( $dp->src !== null ) {
						$out = preg_replace(
							'/^([^:]+:)(.*)$/',
							'$1' . $contentInfo->value . '}}', $dp->src, 1 );
					} else {
						$magicWord = strtoupper( $cat[ 1 ] );
						$state->env->log( 'warn', $cat[ 1 ]
. ' is missing source. Rendering as '
. $magicWord . ' magicword'
						);
						$out = '{{' . $magicWord . ':'
. $contentInfo->value . '}}';
					}
				} else {
					$out = $state->env->conf->wiki->getMagicWordWT(
						$switchType[ 1 ], $dp->magicSrc
					) || '';
				}
				$state->emitChunk( $out, $node );
			} else {
				/* await */ FallbackHTMLHandler::handler( $node, $state );
			}
		} elseif ( $type ) {
			switch ( $type ) {
				case 'mw:Includes/IncludeOnly':
				// Remove the dp.src when older revisions of HTML expire in RESTBase
				$state->emitChunk( $dmw->src || $dp->src || '', $node );
				break;
				case 'mw:Includes/IncludeOnly/End':
				// Just ignore.
				break;
				case 'mw:Includes/NoInclude':
				$state->emitChunk( $dp->src || '<noinclude>', $node );
				break;
				case 'mw:Includes/NoInclude/End':
				$state->emitChunk( $dp->src || '</noinclude>', $node );
				break;
				case 'mw:Includes/OnlyInclude':
				$state->emitChunk( $dp->src || '<onlyinclude>', $node );
				break;
				case 'mw:Includes/OnlyInclude/End':
				$state->emitChunk( $dp->src || '</onlyinclude>', $node );
				break;
				case 'mw:DiffMarker/inserted':

				case 'mw:DiffMarker/deleted':

				case 'mw:DiffMarker/moved':

				case 'mw:Separator':
				// just ignore it
				break;
				default:
				/* await */ FallbackHTMLHandler::handler( $node, $state );
			}
		} else {
			/* await */ FallbackHTMLHandler::handler( $node, $state );
		}
	}
	public function before( $node, $otherNode ) {
		$type =
		( $node->hasAttribute( 'typeof' ) ) ? $node->getAttribute( 'typeof' ) :
		( $node->hasAttribute( 'property' ) ) ? $node->getAttribute( 'property' ) :
		null;
		if ( $type && preg_match( '/mw:PageProp\/categorydefaultsort/', $type ) ) {
			if ( $otherNode->nodeName === 'P' && DOMDataUtils::getDataParsoid( $otherNode )->stx !== 'html' ) {
				// Since defaultsort is outside the p-tag, we need 2 newlines
				// to ensure that it go back into the p-tag when parsed.
				return [ 'min' => 2 ];
			} else {
				return [ 'min' => 1 ];
			}
		} elseif ( WTUtils::isNewElt( $node )
&& // Placeholder metas don't need to be serialized on their own line
				( $node->nodeName !== 'META'
|| !preg_match( '/(^|\s)mw:Placeholder(\/|$)/', $node->getAttribute( 'typeof' ) || '' ) )
		) {
			return [ 'min' => 1 ];
		} else {
			return [];
		}
	}
	public function after( $node, $otherNode ) {
		// No diffs
		if ( WTUtils::isNewElt( $node )
&& // Placeholder metas don't need to be serialized on their own line
				( $node->nodeName !== 'META'
|| !preg_match( '/(^|\s)mw:Placeholder(\/|$)/', $node->getAttribute( 'typeof' ) || '' ) )
		) {
			return [ 'min' => 1 ];
		} else {
			return [];
		}
	}
}

$module->exports = $MetaHandler;
