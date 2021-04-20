<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext\Gallery;

use DOMDocument;
use DOMDocumentFragment;
use DOMElement;

use Wikimedia\Parsoid\Ext\DOMUtils;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Ext\PHPUtils;

class TraditionalMode extends Mode {
	/**
	 * Create a TraditionalMode singleton.
	 * @param ?string $mode Only used by subclasses.
	 */
	protected function __construct( ?string $mode = null ) {
		parent::__construct( $mode ?? 'traditional' );
		$this->scale = 1;
		$this->padding = PHPUtils::arrayToObject( [ 'thumb' => 30, 'box' => 5, 'border' => 8 ] );
	}

	/** @var float */
	protected $scale;
	/** @var object */
	protected $padding;

	/**
	 * @param DOMElement $ul
	 * @param string $k
	 * @param string $v
	 */
	private function appendAttr( DOMElement $ul, string $k, string $v ) {
		$val = $ul->hasAttribute( $k ) ? $ul->getAttribute( $k ) : '';
		if ( strlen( $val ) > 0 ) {
			$val .= ' ';
		}
		$ul->setAttribute( $k, $val . $v );
	}

	/**
	 * @param Opts $opts
	 * @param DOMDocumentFragment $domFragment
	 * @return DOMElement
	 */
	private function ul(
		Opts $opts, DOMDocumentFragment $domFragment
	): DOMElement {
		$ul = $domFragment->ownerDocument->createElement( 'ul' );
		$cl = 'gallery mw-gallery-' . $this->mode;
		$ul->setAttribute( 'class', $cl );
		foreach ( $opts->attrs as $k => $v ) {
			$this->appendAttr( $ul, $k, $v );
		}
		$domFragment->appendChild( $ul );
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

	/**
	 * @param Opts $opts
	 * @param DOMElement $ul
	 * @param DOMDocumentFragment $caption
	 */
	private function caption(
		Opts $opts, DOMElement $ul, DOMDocumentFragment $caption
	) {
		$doc = $ul->ownerDocument;
		$li = $doc->createElement( 'li' );
		$li->setAttribute( 'class', 'gallerycaption' );
		DOMUtils::migrateChildren( $caption, $li );
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
	 * @param ?DOMElement $gallerytext
	 * @param float $width
	 */
	protected function galleryText(
		DOMDocument $doc, DOMElement $box, ?DOMElement $gallerytext,
		float $width
	): void {
		$div = $doc->createElement( 'div' );
		$div->setAttribute( 'class', 'gallerytext' );
		if ( $gallerytext ) {
			ParsoidExtensionAPI::migrateChildrenAndTransferWrapperDataAttribs(
				$gallerytext, $div
			);
		}
		$box->appendChild( $div );
	}

	/**
	 * @param Opts $opts
	 * @param DOMElement $ul
	 * @param ParsedLine $o
	 */
	private function line( Opts $opts, DOMElement $ul, ParsedLine $o ): void {
		$doc = $ul->ownerDocument;

		$width = $this->scaleMedia( $opts, $o->thumb );
		$height = $opts->imageHeight;

		$box = $doc->createElement( 'li' );
		$box->setAttribute( 'class', 'gallerybox' );
		$box->setAttribute( 'style', $this->boxStyle( $width, $height ) );

		$thumb = $doc->createElement( 'div' );
		$thumb->setAttribute( 'class', 'thumb' );
		$thumb->setAttribute( 'style', $this->thumbStyle( $width, $height ) );

		$wrapper = $doc->createElement( 'span' );
		$wrapper->setAttribute( 'typeof', $o->rdfaType );
		ParsoidExtensionAPI::migrateChildrenAndTransferWrapperDataAttribs(
			$o->thumb, $wrapper
		);
		$thumb->appendChild( $wrapper );

		$box->appendChild( $thumb );
		$this->galleryText( $doc, $box, $o->gallerytext, $width );
		$ul->appendChild( $doc->createTextNode( "\n" ) );
		$ul->appendChild( $box );
	}

	/** @inheritDoc */
	public function render(
		ParsoidExtensionAPI $extApi, Opts $opts, ?DOMDocumentFragment $caption,
		array $lines
	): DOMDocumentFragment {
		$domFragment = $extApi->htmlToDom( '' );
		$ul = $this->ul( $opts, $domFragment );
		if ( $caption ) {
			$this->caption( $opts, $ul, $caption );
		}
		foreach ( $lines as $l ) {
			$this->line( $opts, $ul, $l );
		}
		$ul->appendChild( $domFragment->ownerDocument->createTextNode( "\n" ) );
		return $domFragment;
	}

	/**
	 * @return array
	 */
	public function getModuleStyles(): array {
		return [ 'mediawiki.page.gallery.styles' ];
	}

}
