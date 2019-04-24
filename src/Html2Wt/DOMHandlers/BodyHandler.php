<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
namespace Parsoid;

use Parsoid\DOMHandler as DOMHandler;

class BodyHandler extends DOMHandler {
	public function __construct() {
		parent::__construct( false );
	}
	public function handleG( $node, $state, $wrapperUnmodified ) {
		/* await */ $state->serializeChildren( $node );
	}
	public function firstChild() {
		return [ 'min' => 0, 'max' => 1 ];
	}
	public function lastChild() {
		return [ 'min' => 0, 'max' => 1 ];
	}
}

$module->exports = $BodyHandler;
