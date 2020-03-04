<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext\Cite;

use DOMElement;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;

/**
 * wt -> html DOM PostProcessor
 */
class RefProcessor {
	/** @var ParsoidExtensionAPI Provides post-processing support */
	private $extApi;

	/**
	 * @param ParsoidExtensionAPI $extApi
	 */
	public function __construct( ParsoidExtensionAPI $extApi ) {
		$this->extApi = $extApi;
	}

	/**
	 * @param ParsoidExtensionAPI $extApi
	 * @param DOMElement $body
	 * @param array $options
	 * @param bool $atTopLevel
	 */
	public function run(
		ParsoidExtensionAPI $extApi, DOMElement $body, array $options, bool $atTopLevel
	): void {
		if ( $atTopLevel ) {
			$refsData = new ReferencesData();
			References::processRefs( $this->extApi, $refsData, $body );
			References::insertMissingReferencesIntoDOM( $this->extApi, $refsData, $body );
		}
	}
}
