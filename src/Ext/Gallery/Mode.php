<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module */

namespace Parsoid;

$ParsoidExtApi = $module->parent->parent->require( './extapi.js' )->versionCheck( '^0.10.0' );
$temp0 = $ParsoidExtApi;
$DOMDataUtils = $temp0::DOMDataUtils;
$DOMUtils = $temp0::DOMUtils;
$JSUtils = $temp0::JSUtils;
$Util = $temp0::Util;

/** @namespace */
$modes = JSUtils::mapObject( [
		'traditional' => new Traditional(),
		'nolines' => new NoLines(),
		'slideshow' => new Slideshow(),
		'packed' => new Packed(),
		'packed-hover' => new PackedHover(),
		'packed-overlay' => new PackedOverlay()
	]
);

if ( gettype( $module ) === 'object' ) {
	$module->exports = $modes;
}
