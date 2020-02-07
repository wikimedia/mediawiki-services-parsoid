<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext\Cite;

use DOMElement;
use Wikimedia\Parsoid\Config\ParsoidExtensionAPI;

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
	 * @param DOMElement $body
	 * @param mixed $unused unused Env object FIXME: stop passing this through?
	 * @param array $options
	 * @param bool $atTopLevel
	 */
	public function run(
		DOMElement $body, $unused, array $options = [], bool $atTopLevel = false
	): void {
		if ( $atTopLevel ) {
			$refsData = new ReferencesData();
			References::processRefs( $this->extApi, $refsData, $body );
			References::insertMissingReferencesIntoDOM( $this->extApi, $refsData, $body );
		}
	}
}
