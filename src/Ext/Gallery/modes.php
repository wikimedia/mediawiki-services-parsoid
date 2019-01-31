<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module */

namespace Parsoid;

use Parsoid\domino as domino;

$ParsoidExtApi = $module->parent->parent->require( './extapi.js' )->versionCheck( '^0.10.0' );
$temp0 = $ParsoidExtApi;
$DOMDataUtils = $temp0::DOMDataUtils;
$DOMUtils = $temp0::DOMUtils;
$JSUtils = $temp0::JSUtils;
$Util = $temp0::Util;

/**
 * @class
 */
class Traditional {
	public function __construct() {
		$this->mode = 'traditional';
		$this->scale = 1;
		$this->padding = [ 'thumb' => 30, 'box' => 5, 'border' => 8 ];
	}
	public $mode;
	public $scale;
	public $padding;

	public function MODE() {
 return $this->mode;
 }
	public function SCALE() {
 return $this->scale;
 }
	public function PADDING() {
 return $this->padding;
 }

	public function appendAttr( $ul, $k, $v ) {
		$val = $ul->getAttribute( $k ) || '';
		if ( $val ) { $val += ' ';
  }
		$ul->setAttribute( $k, $val + $v );
	}

	public function ul( $opts, $doc ) {
		$ul = $doc->createElement( 'ul' );
		$cl = 'gallery mw-gallery-' . $this::MODE();
		$ul->setAttribute( 'class', $cl );
		Object::keys( $opts->attrs )->forEach( function ( $k ) use ( &$ul, &$opts ) {
				$this->appendAttr( $ul, $k, $opts->attrs[ $k ] );
		}
		);
		$doc->body->appendChild( $ul );
		$this->perRow( $opts, $ul );
		$this->setAdditionalOptions( $opts, $ul );
		return $ul;
	}

	public function perRow( $opts, $ul ) {
		if ( $opts->imagesPerRow > 0 ) {
			$padding = $this::PADDING();
			$total = $opts->imageWidth + $padding->thumb + $padding->box + $padding->border;
			$total *= $opts->imagesPerRow;
			$this->appendAttr( $ul, 'style', implode(

					' ', [
						'max-width: ' . $total . 'px;',
						'_width: ' . $total . 'px;'
					]
				)
			);
		}
	}

	public function setAdditionalOptions( $opts, $ul ) {
 }

	public function caption( $opts, $doc, $ul, $caption ) {
		$li = $doc->createElement( 'li' );
		$li->setAttribute( 'class', 'gallerycaption' );
		DOMUtils::migrateChildrenBetweenDocs( $caption, $li );
		$ul->appendChild( $doc->createTextNode( "\n" ) );
		$ul->appendChild( $li );
	}

	public function dimensions( $opts ) {
		return "{$opts->imageWidth}x{$opts->imageHeight}px";
	}

	public function scaleMedia( $opts, $wrapper ) {
		return $opts->imageWidth;
	}

	public function thumbWidth( $width ) {
		return $width + $this::PADDING()->thumb;
	}

	public function thumbHeight( $height ) {
		return $height + $this::PADDING()->thumb;
	}

	public function thumbStyle( $width, $height ) {
		$style = [ "width: {$this->thumbWidth( $width )}px;" ];
		if ( $this::MODE() === 'traditional' ) {
			$style[] = "height: {$this->thumbHeight( $height )}px;";
		}
		return implode( ' ', $style );
	}

	public function boxWidth( $width ) {
		return $this->thumbWidth( $width ) + $this::PADDING()->box;
	}

	public function boxStyle( $width, $height ) {
		return "width: {$this->boxWidth( $width )}px;";
	}

	public function galleryText( $doc, $box, $gallerytext, $width ) {
		$div = $doc->createElement( 'div' );
		$div->setAttribute( 'class', 'gallerytext' );
		if ( $gallerytext ) {
			DOMUtils::migrateChildrenBetweenDocs( $gallerytext, $div );
		}
		$box->appendChild( $div );
	}

	public function line( $opts, $doc, $ul, $o ) {
		$width = $this->scaleMedia( $opts, $o->thumb );
		$height = $opts->imageHeight;

		$box = $doc->createElement( 'li' );
		$box->setAttribute( 'class', 'gallerybox' );
		$box->setAttribute( 'style', $this->boxStyle( $width, $height ) );

		$thumb = $doc->createElement( 'div' );
		$thumb->setAttribute( 'class', 'thumb' );
		$thumb->setAttribute( 'style', $this->thumbStyle( $width, $height ) );

		$wrapper = $doc->createElement( 'figure-inline' );
		$wrapper->setAttribute( 'typeof', $o->rdfaType );
		// FIXME: Probably want to copy over "data-parsoid" here as well
		// so that the `optList` is preserved for roundtripping but since
		// shadowed information is dropped anyways inside encapsulations,
		// we can leave that until a general solution for T211895 / T151367
		// is hashed out.
		DOMDataUtils::setDataMw( $wrapper, Util::clone( DOMDataUtils::getDataMw( $o->thumb ) ) );
		// Store temporarily, otherwise these get clobbered after rendering by
		// the call to `DOMDataUtils.visitAndLoadDataAttribs()` in `toDOM`.
		DOMDataUtils::storeDataAttribs( $wrapper );
		DOMUtils::migrateChildrenBetweenDocs( $o->thumb, $wrapper );
		$thumb->appendChild( $wrapper );

		$box->appendChild( $thumb );
		$this->galleryText( $doc, $box, $o->gallerytext, $width );
		$ul->appendChild( $doc->createTextNode( "\n" ) );
		$ul->appendChild( $box );
	}

	public function render( $opts, $caption, $lines ) {
		$doc = domino::createDocument();
		$ul = $this->ul( $opts, $doc );
		if ( $caption ) {
			$this->caption( $opts, $doc, $ul, $caption );
		}
		$lines->forEach( function ( $l ) use ( &$opts, &$doc, &$ul ) {return $this->line( $opts, $doc, $ul, $l );
  } );
		$ul->appendChild( $doc->createTextNode( "\n" ) );
		return $doc;
	}
}

/**
 * @class
 * @extends ~Traditional
 */
class NoLines extends Traditional {
	public function __construct() {
		parent::__construct();
		$this->mode = 'nolines';
		$this->padding = [ 'thumb' => 0, 'box' => 5, 'border' => 4 ];
	}
	public $mode;
	public $padding;

}

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
		return "x{Math::trunc( $opts->imageHeight * $this::SCALE() )}px";
	}

	public function scaleMedia( $opts, $wrapper ) {
		$elt = $wrapper->firstChild->firstChild;
		$width = intval( $elt->getAttribute( 'width' ), 10 );
		if ( Number::isNaN( $width ) ) {
			$width = $opts->imageWidth;
		} else {
			$width = Math::trunc( $width / $this::SCALE() );
		}
		$elt->setAttribute( 'width', $width );
		$elt->setAttribute( 'height', $opts->imageHeight );
		return $width;
	}

	public function galleryText( $doc, $box, $gallerytext, $width ) {
		if ( !preg_match( '/packed-(hover|overlay)/', $this::MODE() ) ) {
			call_user_func( [ Traditional::prototype, 'galleryText' ], $doc, $box, $gallerytext );
			return;
		}
		if ( !$gallerytext ) {
			return;
		}
		$div = $doc->createElement( 'div' );
		$div->setAttribute( 'class', 'gallerytext' );
		DOMUtils::migrateChildrenBetweenDocs( $gallerytext, $div );
		$wrapper = $doc->createElement( 'div' );
		$wrapper->setAttribute( 'class', 'gallerytextwrapper' );
		$wrapper->setAttribute( 'style', "width: {$width - 20}px;" );
		$wrapper->appendChild( $div );
		$box->appendChild( $wrapper );
	}
}

/**
 * @class
 * @extends ~Packed
 */
class PackedHover extends Packed {
	public function __construct() {
		parent::__construct();
		$this->mode = 'packed-hover';
	}
	public $mode;

}

/**
 * @class
 * @extends ~Packed
 */
class PackedOverlay extends Packed {
	public function __construct() {
		parent::__construct();
		$this->mode = 'packed-overlay';
	}
	public $mode;

}

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
