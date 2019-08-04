<?php
declare( strict_types = 1 );

namespace Parsoid\Ext\Gallery;

use Parsoid\Config\Env;
use Parsoid\Wt2Html\TT\Sanitizer;
use Parsoid\Utils\Util;

/**
 * @class
 */
class Opts {
	/**
	 * Parse options from an attribute array.
	 * @param Env $env
	 * @param array<string,string> $attrs The attribute array
	 */
	public function __construct( Env $env, array $attrs ) {
		foreach ( $env->getSiteConfig()->galleryOptions() as $k => $v ) {
			$this->$k = $v;
		}

		if ( is_numeric( $attrs['perrow'] ?? null ) ) {
			$this->imagesPerRow = intval( $attrs['perrow'], 10 );
		}

		$maybeDim = Util::parseMediaDimensions( $attrs['widths'] ?? '', true );
		if ( $maybeDim && Util::validateMediaParam( $maybeDim['x'] ) ) {
			$this->imageWidth = $maybeDim['x'];
		}

		$maybeDim = Util::parseMediaDimensions( $attrs['heights'] ?? '', true );
		if ( $maybeDim && Util::validateMediaParam( $maybeDim['x'] ) ) {
			$this->imageHeight = $maybeDim['x'];
		}

		$mode = strtolower( $attrs['mode'] ?? '' );
		if ( Mode::byName( $mode ) !== null ) {
			$this->mode = $mode;
		}

		$this->showfilename = isset( $attrs['showfilename'] );
		$this->showthumbnails = isset( $attrs['showthumbnails'] );
		$this->caption = (bool)( $attrs['caption'] ?? false );

		// TODO: Good contender for T54941
		$validUlAttrs = Sanitizer::attributeWhitelist( 'ul' );
		$this->attrs = [];
		foreach ( $attrs as $k => $v ) {
			if ( !isset( $validUlAttrs[$k] ) ) {
				continue;
			}
			if ( $k === 'style' ) {
				$v = Sanitizer::checkCSS( $v );
			}
			$this->attrs[$k] = $v;
		}
	}

	/** @var array<string,string> */
	public $attrs;

	/** @var int */
	public $imagesPerRow;

	/** @var int */
	public $imageWidth;

	/** @var int */
	public $imageHeight;

	/** @var string */
	public $mode;

	/** @var bool */
	public $showfilename;

	/** @var bool */
	public $showthumbnails;

	/** @var bool */
	public $caption;

}
