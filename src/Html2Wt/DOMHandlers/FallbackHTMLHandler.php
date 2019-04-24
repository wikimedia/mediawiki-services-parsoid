<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
namespace Parsoid;

use Parsoid\DOMUtils as DOMUtils;
use Parsoid\DOMDataUtils as DOMDataUtils;
use Parsoid\TokenUtils as TokenUtils;
use Parsoid\WTSUtils as WTSUtils;

use Parsoid\DOMHandler as DOMHandler;

/**
 * Used as a fallback in other tag handles.
 */
class FallbackHTMLHandler extends DOMHandler {
	public function __construct() {
		parent::__construct( false );
	}

	public function handleG( ...$args ) {
		/* await */ self::handler( ...$args );
	}

	/**
	 * Just the handler for the handle defined above.
	 * It's also used as a fallback in some of the other tag handles.
	 */
	public static function handlerG( $node, $state, $wrapperUnmodified ) {
		$serializer = $state->serializer;

		// Wikitext supports the following list syntax:
		//
		// * <li class="a"> hello world
		//
		// The "LI Hack" gives support for this syntax, and we need to
		// specially reconstruct the above from a single <li> tag.
		$serializer->_handleLIHackIfApplicable( $node );

		$tag = /* await */ $serializer->_serializeHTMLTag( $node, $wrapperUnmodified );
		WTSUtils::emitStartTag( $tag, $node, $state );

		if ( $node->hasChildNodes() ) {
			$inPHPBlock = $state->inPHPBlock;
			if ( TokenUtils::tagOpensBlockScope( strtolower( $node->nodeName ) ) ) {
				$state->inPHPBlock = true;
			}

			// TODO(arlolra): As of 1.3.0, html pre is considered an extension
			// and wrapped in encapsulation.  When that version is no longer
			// accepted for serialization, we can remove this backwards
			// compatibility code.
			if ( $node->nodeName === 'PRE' ) {
				// Handle html-pres specially
				// 1. If the node has a leading newline, add one like it (logic copied from VE)
				// 2. If not, and it has a data-parsoid strippedNL flag, add it back.
				// This patched DOM will serialize html-pres correctly.

				$lostLine = '';
				$fc = $node->firstChild;
				if ( $fc && DOMUtils::isText( $fc ) ) {
					$m = preg_match( '/^\n/', $fc->nodeValue );
					$lostLine = $m && $m[ 0 ] || '';
				}

				if ( !$lostLine && DOMDataUtils::getDataParsoid( $node )->strippedNL ) {
					$lostLine = "\n";
				}

				$state->emitChunk( $lostLine, $node );
			}

			/* await */ $state->serializeChildren( $node );
			$state->inPHPBlock = $inPHPBlock;
		}

		$endTag = /* await */ $serializer->_serializeHTMLEndTag( $node, $wrapperUnmodified );
		WTSUtils::emitEndTag( $endTag, $node, $state );
	}
}

FallbackHTMLHandler::handler = /* async */FallbackHTMLHandler::handlerG;

$module->exports = $FallbackHTMLHandler;
