<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
namespace Parsoid;

use Parsoid\References as References;
use Parsoid\ReferencesData as ReferencesData;

/**
 * wt -> html DOM PostProcessor
 *
 * @class
 */
class RefProcessor {
	public function run( $body, $env, $options, $atTopLevel ) {
		if ( $atTopLevel ) {
			$refsData = new ReferencesData( $env );
			References::_processRefs( $env, $refsData, $body );
			References::insertMissingReferencesIntoDOM( $refsData, $body );
		}
	}
}

$module->exports = $RefProcessor;
