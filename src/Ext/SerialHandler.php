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
	 * Serialized wikitext should be returned via $state::emitChunk().
	 * @param DOMElement $node
	 * @param SerializerState $state
	 * @param bool $wrapperUnmodified
	 * @return DOMElement|null The node to continue with. If $node is returned, the
	 *   serialization will continue with the next sibling. Returning null or the root node of
	 *   the serialization means serialization is finished.
	 */
	public function handle(
		DOMElement $node, SerializerState $state, bool $wrapperUnmodified
	): ?DOMElement;

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
