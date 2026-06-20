<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Fragments;

use Wikimedia\Parsoid\Core\LinkTarget;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;

/**
 * An atomic fragment representing an extension tag encountered during
 * preprocessing. The arguments and body of the extension tag have all
 * potentially been preprocessed into wikitext and fragments, since they
 * may have contained strip markers as well.  We also return the frame
 * "title" at the point where the extension tag was encountered, so that
 * we can properly set up the frame for its eventual expansion.
 */
class ExtTagPFragment extends PFragment {

	public function __construct(
		public string|PFragment $wt,
		public LinkTarget $title,
	) {
		parent::__construct( null );
	}

	/** @inheritDoc */
	public function asDom( ParsoidExtensionAPI $extApi, bool $release = false ): DocumentFragment {
		$df = $extApi->wikitextToDOM(
			$this->wt,
			[
				'parseOpts' => [ 'expandTemplates' => false ],
				'processInNewFrame' => true,
				'newFrameTitle' => $this->title,
			],
			true
		);
		return $df;
	}

}
