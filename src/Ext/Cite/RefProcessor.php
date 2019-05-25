<?php
declare( strict_types = 1 );

namespace Parsoid\Ext\Cite;

use DOMElement;
use Parsoid\Config\Env;

/**
 * wt -> html DOM PostProcessor
 */
class RefProcessor {

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
			References::processRefs( $env, $refsData, $body );
			References::insertMissingReferencesIntoDOM( $refsData, $body );
		}
	}
}
