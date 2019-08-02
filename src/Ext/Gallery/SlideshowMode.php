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

/**
 * @class
 * @extends ~Traditional
 */
class Slideshow extends Traditional {
	public function __construct() {
		parent::__construct();
		$this->mode = 'slideshow';
	}
	public $mode;

	public function setAdditionalOptions( $opts, $ul ) {
		$ul->setAttribute( 'data-showthumbnails', ( $opts->showthumbnails ) ? '1' : '' );
	}
	public function perRow() {
 }
}
