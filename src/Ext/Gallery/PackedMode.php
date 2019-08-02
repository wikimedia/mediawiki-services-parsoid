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
class Packed extends Traditional {
	public function __construct() {
		parent::__construct();
		$this->mode = 'packed';
		$this->scale = 1.5;
		$this->padding = [ 'thumb' => 0, 'box' => 2, 'border' => 8 ];
	}
	public $mode;
	public $scale;
	public $padding;

	public function perRow() {
 }

	public function dimensions( $opts ) {
		return "x{ceil( $opts->imageHeight * $this::SCALE() )}px";
	}

	public function scaleMedia( $opts, $wrapper ) {
		$elt = $wrapper->firstChild->firstChild;
		$width = intval( $elt->getAttribute( 'width' ), 10 );
		if ( Number::isNaN( $width ) ) {
			$width = $opts->imageWidth;
		} else {
			$width /= $this::SCALE();
		}
		$elt->setAttribute( 'width', ceil( $width ) );
		$elt->setAttribute( 'height', $opts->imageHeight );
		return $width;
	}

	public function galleryText( $doc, $box, $gallerytext, $width ) {
		if ( !preg_match( '/packed-(hover|overlay)/', $this::MODE() ) ) {
			call_user_func( [ Traditional::prototype, 'galleryText' ], $doc, $box, $gallerytext, $width );
			return;
		}
		if ( !$gallerytext ) {
			return;
		}
		$div = $doc->createElement( 'div' );
		$div->setAttribute( 'class', 'gallerytext' );
		DOMUtils::migrateChildrenBetweenDocs( $gallerytext, $div );
		$div->setAttribute( 'data-parsoid', $gallerytext->getAttribute( 'data-parsoid' ) );
		// The data-mw attribute *shouldn't* exist, since this gallerytext
		// should be a <figcaption>.  But let's be safe and copy it anyway.
		$div->setAttribute( 'data-mw', $gallerytext->getAttribute( 'data-mw' ) );
		$wrapper = $doc->createElement( 'div' );
		$wrapper->setAttribute( 'class', 'gallerytextwrapper' );
		$wrapper->setAttribute( 'style', "width: {ceil( $width - 20 )}px;" );
		$wrapper->appendChild( $div );
		$box->appendChild( $wrapper );
	}
}
