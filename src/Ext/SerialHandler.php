<?php
declare( strict_types = 1 );

namespace Parsoid\Ext;

use DOMElement;
use Parsoid\Html2Wt\SerializerState;

interface SerialHandler {

	/**
	 * Serialize a DOM node created by this extension to wikitext.
	 * Serialized wikitext should be returned via $state::emitChunk().
	 * @param DOMElement $node
	 * @param SerializerState $state
	 * @param bool $wrapperUnmodified
	 */
	public function handle( DOMElement $node, SerializerState $state, bool $wrapperUnmodified ): void;

}
