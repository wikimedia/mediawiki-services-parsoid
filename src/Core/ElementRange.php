<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Core;

use Wikimedia\Parsoid\DOM\Element;

/**
 * A simple pair of DOM elements
 */
class ElementRange {

	public ?Element $startElem = null;

	public ?Element $endElem = null;
}
