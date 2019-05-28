<?php
declare( strict_types = 1 );

namespace Parsoid\Ext;

use DOMElement;
use DOMNode;
use Parsoid\Html2Wt\SerializerState;

/**
 * Interface for extensions with custom serialization behavior.
 */
interface SerialHandler {

	/**
	 * Serialize a DOM node created by this extension to wikitext.
	 * @param DOMElement $node
	 * @param SerializerState $state
	 * @param bool $wrapperUnmodified
	 */
	public function fromHTML(
		DOMElement $node, SerializerState $state, bool $wrapperUnmodified
	): string;

	/**
	 * PORT-FIXME Per Subbu, extensions should not know about anything outside their tag so this
	 *   will probably be replaced by something that informs the serializer about the expected
	 *   behavior on a more abstract level (such as block vs inline). For now, there's
	 *   SerialHandlerTrait to provide a default implementation.
	 * @param DOMElement $node
	 * @param DOMNode $otherNode
	 * @param SerializerState $state
	 * @return array|null
	 */
	public function before( DOMElement $node, DOMNode $otherNode, SerializerState $state ): ?array;

}
