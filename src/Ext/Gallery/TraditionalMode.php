<?php
declare( strict_types = 1 );

namespace Parsoid\Ext\Gallery;

use DOMDocument;
use DOMElement;

use Parsoid\Config\Env;
use Parsoid\Utils\DOMCompat;
use Parsoid\Utils\DOMDataUtils;
use Parsoid\Utils\DOMUtils;
use Parsoid\Utils\PHPUtils;
use Parsoid\Utils\Util;

/**
 * @class
 */
class TraditionalMode extends Mode {
	/**
	 * Create a TraditionalMode singleton.
	 * @param string|null $mode Only used by subclasses.
	 */
	protected function __construct( string $mode = null ) {
		parent::__construct( $mode ?? 'traditional' );
		$this->scale = 1;
		$this->padding = PHPUtils::arrayToObject( [ 'thumb' => 30, 'box' => 5, 'border' => 8 ] );
	}

	/** @var float */
	protected $scale;
	/** @var object */
	protected $padding;

	private function appendAttr( DOMElement $ul, string $k, string $v ) {
		$val = $ul->hasAttribute( $k ) ? $ul->getAttribute( $k ) : '';
		if ( strlen( $val ) > 0 ) {
			$val .= ' ';
		}
		$ul->setAttribute( $k, $val . $v );
	}

	private function ul( Opts $opts, DOMDocument $doc ): DOMElement {
		$ul = $doc->createElement( 'ul' );
		$cl = 'gallery mw-gallery-' . $this->mode;
		$ul->setAttribute( 'class', $cl );
		foreach ( $opts->attrs as $k => $v ) {
			$this->appendAttr( $ul, $k, $v );
		}
		DOMCompat::getBody( $doc )->appendChild( $ul );
		$this->perRow( $opts, $ul );
		$this->setAdditionalOptions( $opts, $ul );
		return $ul;
	}

	/**
	 * @param Opts $opts
	 * @param DOMElement $ul
	 */
	protected function perRow( Opts $opts, DOMElement $ul ): void {
		if ( $opts->imagesPerRow > 0 ) {
			$padding = $this->padding;
			$total = $opts->imageWidth + $padding->thumb + $padding->box + $padding->border;
			$total *= $opts->imagesPerRow;
			$this->appendAttr( $ul, 'style', 'max-width: ' . $total . 'px;' );
			$this->appendAttr( $ul, 'style', '_width: ' . $total . 'px;' );
		}
	}

	/**
	 * @param Opts $opts
	 * @param DOMElement $ul
	 */
	protected function setAdditionalOptions( Opts $opts, DOMElement $ul ): void {
	}

	private function caption(
		Opts $opts, DOMDocument $doc, DOMElement $ul, DOMElement $caption
	) {
		$li = $doc->createElement( 'li' );
		$li->setAttribute( 'class', 'gallerycaption' );
		DOMUtils::migrateChildrenBetweenDocs( $caption, $li );
		if ( $caption->hasAttribute( 'data-parsoid' ) ) {
			$li->setAttribute( 'data-parsoid', $caption->getAttribute( 'data-parsoid' ) );
		}
		// The data-mw attribute *shouldn't* exist, since this caption
		// should be a <body>.  But let's be safe and copy it anyway.
		if ( $caption->hasAttribute( 'data-mw' ) ) {
			$li->setAttribute( 'data-mw', $caption->getAttribute( 'data-mw' ) );
		}
		$ul->appendChild( $doc->createTextNode( "\n" ) );
		$ul->appendChild( $li );
	}

	/** @inheritDoc */
	public function dimensions( Opts $opts ): string {
		return "{$opts->imageWidth}x{$opts->imageHeight}px";
	}

	/**
	 * @param Opts $opts
	 * @param DOMElement $wrapper
	 * @return int|float
	 */
	protected function scaleMedia( Opts $opts, DOMElement $wrapper ) {
		return $opts->imageWidth;
	}

	/**
	 * @param float|int $width
	 * @return float|int
	 */
	protected function thumbWidth( $width ) {
		return $width + $this->padding->thumb;
	}

	/**
	 * @param float|int $height
	 * @return float|int
	 */
	protected function thumbHeight( $height ) {
		return $height + $this->padding->thumb;
	}

	/**
	 * @param float|int $width
	 * @param float|int $height
	 * @return string
	 */
	protected function thumbStyle( $width, $height ): string {
		$style = [ 'width: ' . $this->thumbWidth( $width ) . 'px;' ];
		if ( $this->mode === 'traditional' ) {
			$style[] = 'height: ' . $this->thumbHeight( $height ) . 'px;';
		}
		return implode( ' ', $style );
	}

	/**
	 * @param float|int $width
	 * @return float|int
	 */
	protected function boxWidth( $width ) {
		return $this->thumbWidth( $width ) + $this->padding->box;
	}

	/**
	 * @param float|int $width
	 * @param float|int $height
	 * @return string
	 */
	protected function boxStyle( $width, $height ): string {
		return 'width: ' . $this->boxWidth( $width ) . 'px;';
	}

	/**
	 * @param DOMDocument $doc
	 * @param DOMElement $box
	 * @param DOMElement|null $gallerytext
	 * @param float $width
	 */
	protected function galleryText(
		DOMDocument $doc, DOMElement $box, ?DOMElement $gallerytext, float $width
	): void {
		$div = $doc->createElement( 'div' );
		$div->setAttribute( 'class', 'gallerytext' );
		if ( $gallerytext ) {
			DOMUtils::migrateChildrenBetweenDocs( $gallerytext, $div );
			if ( $gallerytext->hasAttribute( 'data-parsoid' ) ) {
				$div->setAttribute( 'data-parsoid', $gallerytext->getAttribute( 'data-parsoid' ) );
			}
			// The data-mw attribute *shouldn't* exist, since this gallerytext
			// should be a <figcaption>.  But let's be safe and copy it anyway.
			if ( $gallerytext->hasAttribute( 'data-mw' ) ) {
				$div->setAttribute( 'data-mw', $gallerytext->getAttribute( 'data-mw' ) );
			}
		}
		$box->appendChild( $div );
	}

	private function line(
		Opts $opts, DOMDocument $doc, DOMElement $ul, ParsedLine $o
	): void {
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
		DOMDataUtils::setDataParsoid(
			$wrapper, Util::clone( DOMDataUtils::getDataParsoid( $o->thumb ) )
		);
		DOMDataUtils::setDataMw(
			$wrapper, Util::clone( DOMDataUtils::getDataMw( $o->thumb ) )
		);
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

	/** @inheritDoc */
	public function render(
		Env $env, Opts $opts, ?DOMElement $caption, array $lines
	): DOMDocument {
		$doc = $env->createDocument();
		$ul = $this->ul( $opts, $doc );
		if ( $caption ) {
			$this->caption( $opts, $doc, $ul, $caption );
		}
		foreach ( $lines as $l ) {
			$this->line( $opts, $doc, $ul, $l );
		}
		$ul->appendChild( $doc->createTextNode( "\n" ) );
		return $doc;
	}
}
