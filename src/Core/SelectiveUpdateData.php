<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Core;

use Wikimedia\Parsoid\DOM\Document;

/**
 * Data that's necessary for selective updates (whether html->wt or wt->html).
 * This is always revision (current or previous)wikitext & html.
 */
class SelectiveUpdateData {
	public string $revText;
	public ?string $revHTML;

	/**
	 * DOM document corresponding to $revHTML
	 */
	public Document $revDOM;

	/**
	 * If we are doing selective updates for a template edit,
	 * title string of the edited template.
	 */
	public ?string $templateTitle;

	/**
	 * Options for selective HTML updates: template, section, generic
	 */
	public ?string $mode;

	/**
	 * Data that's necessary to perform selective serialization.
	 */
	public function __construct(
		string $revText, ?string $revHTML = null, ?string $mode = null
	) {
		$this->revText = $revText;
		$this->revHTML = $revHTML;
		$this->mode = $mode;
	}
}
