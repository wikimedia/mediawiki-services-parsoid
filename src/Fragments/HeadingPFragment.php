<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Fragments;

use Wikimedia\Parsoid\Core\LinkTarget;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\Title;

/**
 * An atomic fragment representing a wikitext heading return by the legacy
 * preprocessor.  It provides the context title of page the heading
 * originated on and the index of the heading on the page
 */
class HeadingPFragment extends PFragment {

	public function __construct(
		public string|PFragment $wt,
		public LinkTarget $title,
		public int $index
	) {
		parent::__construct( null );
	}

	/** @inheritDoc */
	public function asDom( ParsoidExtensionAPI $extApi, bool $release = false ): DocumentFragment {
		$df = $extApi->wikitextToDOM(
			$this->wt,
			[ 'parseOpts' => [ 'expandTemplates' => false ] ],
			true
		);
		if ( DOMUtils::isHeading( $df->firstChild ) ) {
			DOMDataUtils::getDataParsoid( $df->firstChild )->getTemp()->headingData = [
				Title::newFromLinkTarget( $this->title, $extApi->getSiteConfig() ),
				$this->index
			];
		}
		return $df;
	}

}
