<?php
declare( strict_types = 1 );

namespace Parsoid\Tests\ParserTests;

class Item {
	/** @var string */
	public $type;

	public function __construct( string $type ) {
		$this->type = $type;
	}
}
