<?php
declare( strict_types = 1 );

namespace Parsoid\Ext;

use DOMDocument;
use Parsoid\Config\ParsoidExtensionAPI;

interface ExtensionTag {
	/**
	 * Convert an extension tag to DOM.
	 * @param ParsoidExtensionAPI $extApi
	 * @param string $txt Extension tag contents
	 * @param array $extArgs Extension tag arguments
	 * @return DOMDocument
	 */
	public function toDOM( ParsoidExtensionAPI $extApi, string $txt, array $extArgs ): DOMDocument;
}
