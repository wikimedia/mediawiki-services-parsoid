<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Tests\ParserTests;

class Item {
	/** @var string */
	public $type;

	public function __construct( string $type ) {
		$this->type = $type;
	}
}
