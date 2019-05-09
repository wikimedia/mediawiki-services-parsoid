<?php
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module ext/Translate */

namespace Parsoid;

$module->parent->require( './extapi.js' )->versionCheck( '^0.10.0' );

// Translate constructor
$module->exports = function () {
	$this->config = [
		'tags' => [
			[ 'name' => 'translate' ],
			[ 'name' => 'tvar' ]
		]
	];
};
