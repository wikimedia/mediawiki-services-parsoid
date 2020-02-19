<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext;

use DOMDocument;

use Wikimedia\Parsoid\Config\ParsoidExtensionAPI;

abstract class ContentModelHandlerExtension implements Extension {

	/**
	 * @param ParsoidExtensionAPI $extApi
	 * @param string $txt
	 * @return DOMDocument
	 */
	abstract public function toDOM(
		ParsoidExtensionAPI $extApi, string $txt
	): DOMDocument;

	/**
	 * @param ParsoidExtensionAPI $extApi
	 * @param DOMDocument $doc
	 * @return string
	 */
	abstract public function fromDOM(
		ParsoidExtensionAPI $extApi, DOMDocument $doc
	): string;

}
