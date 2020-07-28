<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext\Cite;

use DOMNode;
use Wikimedia\Parsoid\Ext\DOMProcessor;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;

/**
 * wt -> html DOM PostProcessor
 */
class RefProcessor extends DOMProcessor {

	/**
	 * @inheritDoc
	 */
	public function wtPostprocess(
		ParsoidExtensionAPI $extApi, DOMNode $node, array $options, bool $atTopLevel
	): void {
		if ( $atTopLevel ) {
			$refsData = new ReferencesData();
			References::processRefs( $extApi, $refsData, $node );
			References::insertMissingReferencesIntoDOM( $extApi, $refsData, $node );
		}
	}

	// FIXME: should implement an htmlPreprocess method as well.
}
