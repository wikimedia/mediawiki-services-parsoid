<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
namespace Parsoid;

use Parsoid\DOMHandler as DOMHandler;

class AHandler extends DOMHandler {
	public function __construct() {
		parent::__construct( false );
	}
	public function handleG( $node, $state, $wrapperUnmodified ) {
		/* await */ $state->serializer->linkHandler( $node );
	}
	// TODO: Implement link tail escaping with nowiki in DOM handler!
}

$module->exports = $AHandler;
