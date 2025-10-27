<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TreeBuilder;

use Wikimedia\Parsoid\DOM\DOMException;
use Wikimedia\Parsoid\DOM\DOMImplementation;
use Wikimedia\Parsoid\DOM\HTMLDocument;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\RemexHtml\DOM\DOMBuilder as RemexDOMBuilder;

/**
 * This is the DOMBuilder subclass used by Wt2Html
 */
class ParsoidDOMBuilder extends RemexDOMBuilder {
	public function __construct() {
		// Ensure that Parsoid DOM aliases are loaded.
		class_exists( HTMLDocument::class );
		parent::__construct( DOMCompat::isStandardsMode() ? [
			'suppressIdAttribute' => DOMCompat::isUsingDodo(),
			'domExceptionClass' => DOMException::class,
			'domImplementationClass' => DOMImplementation::class,
		] : [
			'suppressHtmlNamespace' => true,
		] );
	}

	/** @inheritDoc */
	protected function createDocument(
		?string $doctypeName = null,
		?string $public = null,
		?string $system = null
	) {
		// @phan-suppress-next-line PhanTypeMismatchReturn
		return DOMCompat::newDocument();
	}
}
