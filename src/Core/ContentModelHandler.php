<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Core;

use Wikimedia\Parsoid\DOM\Document;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;

abstract class ContentModelHandler {

	/**
	 * @param ParsoidExtensionAPI $extApi
	 * @param ?SelectiveUpdateData $selectiveUpdateData
	 * @return Document
	 */
	abstract public function toDOM(
		ParsoidExtensionAPI $extApi, ?SelectiveUpdateData $selectiveUpdateData = null
	): Document;

	/**
	 * @param ParsoidExtensionAPI $extApi
	 * @param ?SelectiveUpdateData $selectiveUpdateData
	 * @return string
	 */
	abstract public function fromDOM(
		ParsoidExtensionAPI $extApi, ?SelectiveUpdateData $selectiveUpdateData = null
	): string;

}
