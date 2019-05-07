<?php
declare( strict_types = 1 );

namespace Parsoid;

/**
 * PORT-FIXME: This is just a placeholder for data that was previously passed
 * to entrypoint in JavaScript.  Who will construct these objects and whether
 * this is the correct interface is yet to be determined.
 */
class Selser {
	/** @var string */
	public $oldText;

	/** @var string */
	public $oldHTML;

	/**
	 * Data that's necessary to perform selective serialization.
	 *
	 * @param string $oldText
	 * @param string $oldHTML
	 */
	public function __construct( string $oldText, string $oldHTML ) {
		$this->oldText = $oldText;
		$this->oldHTML = $oldHTML;
	}
}
