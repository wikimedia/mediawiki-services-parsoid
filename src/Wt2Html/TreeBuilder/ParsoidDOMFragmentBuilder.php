<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\TreeBuilder;

use Wikimedia\Parsoid\DOM\Document;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\RemexHtml\DOM\DOMFragmentBuilder as RemexDOMFragmentBuilder;

/**
 * This is the DOMFragmentBuilder subclass used by DOMCompat::innerHTML
 */
class ParsoidDOMFragmentBuilder extends RemexDOMFragmentBuilder {

	/** @param Document $ownerDocument */
	public function __construct( $ownerDocument ) {
		'@phan-var \DOMDocument $ownerDocument'; // Remex pretends everything is \DOM
		parent::__construct( $ownerDocument, [
			'suppressIdAttribute' => DOMCompat::isUsingDodo(),
		] );
	}

	/** @return DocumentFragment */
	public function getFragment() {
		$frag = parent::getFragment();
		'@phan-var DocumentFragment $frag'; // Remex pretends everything is \DOM
		return $frag;
	}
}
