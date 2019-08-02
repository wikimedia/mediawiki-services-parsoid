<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */

namespace Parsoid;

$ParsoidExtApi = $module->parent->require( './extapi.js' )->versionCheck( '^0.10.0' );
$temp0 =

$ParsoidExtApi;
$ContentUtils = $temp0::ContentUtils; $DOMDataUtils = $temp0::
DOMDataUtils; $DOMUtils = $temp0::
DOMUtils; $parseWikitextToDOM = $temp0->
parseWikitextToDOM; $Promise = $temp0::
Promise; $Sanitizer = $temp0::
Sanitizer; $TokenUtils = $temp0::
TokenUtils; $Util = $temp0::
Util;

/**
 * @class
 */
class Opts {
	public function __construct( $env, $attrs ) {
		Object::assign( $this, $env->conf->wiki->siteInfo->general->galleryoptions );

		$perrow = intval( $attrs->perrow, 10 );
		if ( !Number::isNaN( $perrow ) ) { $this->imagesPerRow = $perrow;
  }

		$maybeDim = Util::parseMediaDimensions( String( $attrs->widths ), true );
		if ( $maybeDim && Util::validateMediaParam( $maybeDim->x ) ) {
			$this->imageWidth = $maybeDim->x;
		}

		$maybeDim = Util::parseMediaDimensions( String( $attrs->heights ), true );
		if ( $maybeDim && Util::validateMediaParam( $maybeDim->x ) ) {
			$this->imageHeight = $maybeDim->x;
		}

		$mode = strtolower( $attrs->mode || '' );
		if ( $modes->has( $mode ) ) { $this->mode = $mode;
  }

		$this->showfilename = ( $attrs->showfilename !== null );
		$this->showthumbnails = ( $attrs->showthumbnails !== null );
		$this->caption = $attrs->caption;

		// TODO: Good contender for T54941
		$validUlAttrs = Sanitizer::attributeWhitelist( 'ul' );
		$this->attrs = array_reduce( Object::keys( $attrs )->
			filter( function ( $k ) { return $validUlAttrs->has( $k );
   } ),
			function ( $o, $k ) {
				$o[ $k ] = ( $k === 'style' ) ? Sanitizer::checkCss( $attrs[ $k ] ) : $attrs[ $k ];
				return $o;
			}, []
		);
	}
	public $attrs;
	public $imagesPerRow;

	public $imageWidth;

	public $imageHeight;

	public $mode;

	public $showfilename;
	public $showthumbnails;
	public $caption;

}
