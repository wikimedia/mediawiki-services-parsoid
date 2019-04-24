<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
namespace Parsoid;

use Parsoid\DOMUtils as DOMUtils;
use Parsoid\DOMDataUtils as DOMDataUtils;
use Parsoid\WTUtils as WTUtils;

use Parsoid\DOMHandler as DOMHandler;

class LIHandler extends DOMHandler {
	public function __construct() {
		parent::__construct( true );
	}
	public function handleG( $node, $state, $wrapperUnmodified ) {
		$firstChildElement = DOMUtils::firstNonSepChild( $node );
		if ( !DOMUtils::isList( $firstChildElement )
|| WTUtils::isLiteralHTMLNode( $firstChildElement )
		) {
			$state->emitChunk( $this->getListBullets( $state, $node ), $node );
		}
		$liHandler = function ( $state, $text, $opts ) use ( &$state, &$node ) {return $state->serializer->wteHandlers->liHandler( $node, $state, $text, $opts );
		};
		$state->singleLineContext->enforce();
		/* await */ $state->serializeChildren( $node, $liHandler );
		array_pop( $state->singleLineContext );
	}
	public function before( $node, $otherNode ) {
		if ( ( $otherNode === $node->parentNode && isset( [ 'UL' => 1, 'OL' => 1 ][ $otherNode->nodeName ] ) )
|| ( DOMUtils::isElt( $otherNode ) && DOMDataUtils::getDataParsoid( $otherNode )->stx === 'html' )
		) {
			return [];
		} else {
			return [ 'min' => 1, 'max' => 2 ];
		}
	}
	public function after( ...$args ) {
		return $this->wtListEOL( ...$args );
	}
	public function firstChild( $node, $otherNode ) {
		if ( !DOMUtils::isList( $otherNode ) ) {
			return [ 'min' => 0, 'max' => 0 ];
		} else {
			return [];
		}
	}
}

$module->exports = $LIHandler;
