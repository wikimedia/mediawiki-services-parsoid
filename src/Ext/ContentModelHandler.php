<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext;

use DOMDocument;

/**
 * A Parsoid extension module may contain one more more
 * ContentModelHandlers, which allow Parsoid to round-trip a certain
 * content model to and from HTML.
 */
abstract class ContentModelHandler {

	/**
	 * @param ParsoidExtensionAPI $extApi
	 * @return DOMDocument
	 */
	abstract public function toDOM( ParsoidExtensionAPI $extApi ): DOMDocument;

	/**
	 * @param ParsoidExtensionAPI $extApi
	 * @return string
	 */
	abstract public function fromDOM( ParsoidExtensionAPI $extApi ): string;

}
