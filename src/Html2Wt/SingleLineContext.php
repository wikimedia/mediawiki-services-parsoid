<?php
declare( strict_types = 1 );

namespace Parsoid\Html2Wt;

/**
 * Stack and helpers to enforce single-line context while serializing.
 */
class SingleLineContext {
	// PORT-TODO document

	/** @var array  */
	private $stack;

	public function __construct() {
		$this->stack = [];
	}

	public function enforce() {
		$this->stack[] = true;
	}

	public function enforced() {
		return count( $this->stack ) > 0 && end( $this->stack );
	}

	public function disable() {
		$this->stack[] = false;
	}

	public function pop() {
		array_pop( $this->stack );
	}

}
