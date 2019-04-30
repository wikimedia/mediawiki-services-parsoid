<?php

namespace Parsoid\Wt2Html\PP\Processors;

use DOMElement;

class Normalize {
	/**
	 * @param DOMElement $body
	 */
	public function run( DOMElement $body ): void {
		$body->normalize();
	}
}
