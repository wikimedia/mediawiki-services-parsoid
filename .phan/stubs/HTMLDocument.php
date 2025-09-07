<?php
declare( strict_types = 1 );
namespace Wikimedia\Parsoid\DOM;

class HTMLDocument extends \Wikimedia\Parsoid\DOM\Document {
	// Stub out these methods defined in PHP 8.4+

	public static function createEmpty( string $encoding = "UTF-8" ): self {
	}

	public static function createFromString(
		string $source, int $options = 0, ?string $overrideEncoding = null
	): self {
	}
}
