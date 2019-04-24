<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
namespace Parsoid;

use Parsoid\WTUtils as WTUtils;

use Parsoid\DOMHandler as DOMHandler;

class LinkHandler extends DOMHandler {
	public function __construct() {
		parent::__construct( false );
	}
	public function handleG( $node, $state, $wrapperUnmodified ) {
		/* await */ $state->serializer->linkHandler( $node );
	}
	public function before( $node, $otherNode ) {
		// sol-transparent link nodes are the only thing on their line.
		// But, don't force separators wrt to its parent (body, p, list, td, etc.)
		if ( $otherNode !== $node->parentNode
&& WTUtils::isSolTransparentLink( $node ) && !WTUtils::isRedirectLink( $node )
&& !WTUtils::isEncapsulationWrapper( $node )
		) {
			return [ 'min' => 1 ];
		} else {
			return [];
		}
	}
	public function after( $node, $otherNode, $state ) {
		// sol-transparent link nodes are the only thing on their line
		// But, don't force separators wrt to its parent (body, p, list, td, etc.)
		if ( $otherNode !== $node->parentNode
&& WTUtils::isSolTransparentLink( $node ) && !WTUtils::isRedirectLink( $node )
&& !WTUtils::isEncapsulationWrapper( $node )
		) {
			return [ 'min' => 1 ];
		} else {
			return [];
		}
	}
}

$module->exports = $LinkHandler;
