<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
namespace Parsoid;

use Parsoid\DOMDataUtils as DOMDataUtils;

use Parsoid\DOMHandler as DOMHandler;

class HRHandler extends DOMHandler {
	public function __construct() {
		parent::__construct( false );
	}
	public function handleG( $node, $state, $wrapperUnmodified ) {
 // eslint-disable-line require-yield
		$state->emitChunk( '-'->repeat( 4 + ( DOMDataUtils::getDataParsoid( $node )->extra_dashes || 0 ) ), $node );
	}
	public function before() {
		return [ 'min' => 1, 'max' => 2 ];
	}
	// XXX: Add a newline by default if followed by new/modified content
	public function after() {
		return [ 'min' => 0, 'max' => 2 ];
	}
}

$module->exports = $HRHandler;
