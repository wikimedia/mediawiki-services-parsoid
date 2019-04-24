<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
namespace Parsoid;

use Parsoid\DOMUtils as DOMUtils;
use Parsoid\WTUtils as WTUtils;

use Parsoid\DOMHandler as DOMHandler;

class FigureHandler extends DOMHandler {
	public function __construct() {
		parent::__construct( false );
	}
	public function handleG( $node, $state, $wrapperUnmodified ) {
		/* await */ $state->serializer->figureHandler( $node );
	}
	public function before( $node ) {
		if (
			WTUtils::isNewElt( $node )
&& $node->parentNode
&& DOMUtils::isBody( $node->parentNode )
		) {
			return [ 'min' => 1 ];
		}
		return [];
	}
	public function after( $node ) {
		if (
			WTUtils::isNewElt( $node )
&& $node->parentNode
&& DOMUtils::isBody( $node->parentNode )
		) {
			return [ 'min' => 1 ];
		}
		return [];
	}
}

$module->exports = $FigureHandler;
