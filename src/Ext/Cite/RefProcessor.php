<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext\Cite;

use DOMElement;
use Wikimedia\Parsoid\Config\Env;
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
	 * @param Env $env
	 * @param array $options
	 * @param bool $atTopLevel
	 */
	public function run(
		DOMElement $body, Env $env, array $options = [], bool $atTopLevel = false
	): void {
		if ( $atTopLevel ) {
			$refsData = new ReferencesData( $env );
			References::processRefs( $this->extApi, $refsData, $body );
			References::insertMissingReferencesIntoDOM( $refsData, $body );
		}
	}
}
