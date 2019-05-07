<?php
declare( strict_types = 1 );

namespace Parsoid;

/**
 * PORT-FIXME: This is just a placeholder for data that was previously passed
 * to entrypoint in JavaScript.  Who will construct these objects and whether
 * this is the correct interface is yet to be determined.
 */
class PageBundle {
	/** @var string */
	public $html;

	/** @var string */
	public $parsoid;

	/** @var string */
	public $mw;

	/**
	 * @param string $html
	 * @param string $parsoid
	 * @param string $mw
	 */
	public function __construct( string $html, string $parsoid = '', string $mw = '' ) {
		$this->html = $html;
		$this->parsoid = $parsoid;
		$this->mw = $mw;
	}
}
