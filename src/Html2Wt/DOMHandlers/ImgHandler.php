<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
namespace Parsoid;

use Parsoid\DOMHandler as DOMHandler;

class ImgHandler extends DOMHandler {
	public function __construct() {
		parent::__construct( false );
	}
	public function handleG( $node, $state, $wrapperUnmodified ) {
		if ( $node->getAttribute( 'rel' ) === 'mw:externalImage' ) {
			$state->serializer->emitWikitext( $node->getAttribute( 'src' ) || '', $node );
		} else {
			/* await */ $state->serializer->figureHandler( $node );
		}
	}
}

$module->exports = $ImgHandler;
