<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Core;

/**
 * Represents the simplest possible Source: just a string, of unknown
 * origin.  Generally speaking we should use a more informative Source.
 */
class SourceString implements Source {
	public function __construct( public string $srcText ) {
	}

	public function getSrcText(): string {
		return $this->srcText;
	}
}
