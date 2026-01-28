<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext;

use Wikimedia\Parsoid\DOM\Document;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\Utils\ContentUtils as CU;

/**
 * These utilities are for processing content that's generated
 * by parsing source input (ex: wikitext)
 */
class ContentUtils {
	/**
	 * Create a new prepared document with the given HTML and load the
	 * data attributes.
	 *
	 * @param string $html
	 * @param array $options
	 * @return Document
	 */
	public static function createAndLoadDocument(
		string $html, array $options = []
	): Document {
		return CU::createAndLoadDocument( $html, $options );
	}

	/**
	 * @param Document $doc
	 * @param string $html
	 * @param ?array $options Not used
	 * @return DocumentFragment
	 */
	public static function createAndLoadDocumentFragment(
		Document $doc, string $html, ?array $options = null
	): DocumentFragment {
		return CU::createAndLoadDocumentFragment( $doc, $html, $options );
	}
}
