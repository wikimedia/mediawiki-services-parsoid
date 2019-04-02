<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module */

namespace Parsoid;

/**
 * @class
 */
class Normalize {
	public function run( $body ) {
		$body->normalize();
	}
}

$module->exports->Normalize = $Normalize;
