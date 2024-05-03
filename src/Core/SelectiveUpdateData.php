<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Core;

use Wikimedia\Parsoid\DOM\Document;

/**
 * Data that's necessary for selective updates (whether html->wt or wt->html).
 * This is always revision (current or previous)wikitext & html.
 */
class SelectiveUpdateData {
	/** @var string */
	public $revText;

	/** @var ?string */
	public $revHTML;

	/**
	 * DOM document corresponding to $revHTML
	 * @var Document
	 */
	public $revDOM;

	/**
	 * Data that's necessary to perform selective serialization.
	 *
	 * @param string $revText
	 * @param ?string $revHTML
	 */
	public function __construct( string $revText, ?string $revHTML = null ) {
		$this->revText = $revText;
		$this->revHTML = $revHTML;
	}
}
