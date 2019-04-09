<?php
declare( strict_types = 1 );

namespace Parsoid\Ext;

use DOMDocument;
use Parsoid\Wt2Html\TT\ParserState;

interface ExtensionTag {

	/**
	 * Convert an extension tag to DOM.
	 * @param ParserState $state
	 * @param string $txt Extension tag contents
	 * @param array $extArgs Extension tag arguments
	 * @return DOMDocument
	 */
	public function toDOM( ParserState $state, string $txt, array $extArgs ): DOMDocument;

}
