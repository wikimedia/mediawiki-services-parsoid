<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
namespace Parsoid;

use Parsoid\DOMHandler as DOMHandler;
use Parsoid\FallbackHTMLHandler as FallbackHTMLHandler;

class HTMLPreHandler extends DOMHandler {
	public function __construct() {
		parent::__construct( false );
	}
	public function handleG( ...$args ) {
		/* await */ FallbackHTMLHandler::handler( ...$args );
	}
	public function firstChild() {
		return [ 'max' => Number\MAX_VALUE ];
	}
	public function lastChild() {
		return [ 'max' => Number\MAX_VALUE ];
	}
}

$module->exports = $HTMLPreHandler;
