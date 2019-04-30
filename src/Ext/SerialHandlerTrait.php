<?php
declare( strict_types = 1 );

namespace Parsoid\Ext;

use DOMElement;
use DOMNode;
use Parsoid\Html2Wt\SerializerState;

trait SerialHandlerTrait {

	/**
	 * @inheritDoc
	 * This replaces not having a 'before' method on the duck typed interface that was the
	 * Javascript equivalent of SerialHandler.
	 */
	public function before( DOMElement $node, DOMNode $otherNode, SerializerState $state ): ?array {
		return null;
	}

}
