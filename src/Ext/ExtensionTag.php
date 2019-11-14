<?php
declare( strict_types = 1 );

namespace Parsoid\Ext;

use DOMDocument;
use DOMElement;
use DOMNode;
use Parsoid\Config\ParsoidExtensionAPI;
use Parsoid\Html2Wt\SerializerState;

/**
 * A Parsoid native extension.  The only method which is generally
 * required by all extensions is `toDOM` (but Translate doesn't even
 * implement that).  All other methods have default do-nothing
 * implementations; override them iff you wish to implement those
 * features.  Default implementations consistently return `false`
 * to indicate not-implemented (in some cases `null` would be a
 * valid return value, and in other cases `null` would be a likely
 * "accidental" return value which we'd like to catch and flag).
 */
abstract class ExtensionTag {

	/**
	 * Convert an extension tag to DOM.
	 * @param ParsoidExtensionAPI $extApi
	 * @param string $txt Extension tag contents
	 * @param array $extArgs Extension tag arguments
	 * @return DOMDocument|false
	 */
	public function toDOM( ParsoidExtensionAPI $extApi, string $txt, array $extArgs ) {
		return false; /* Use default wrapper */
	}

	/**
	 * Lint handler for this extension.
	 *
	 * If the extension has lints it wants to expose, it should use $extApi
	 * to register those lints. Alternatively, the extension might simply
	 * inspect its DOM and invoke the default lint handler on a DOM tree
	 * that it wants inspected. For example, <ref> nodes often only have
	 * a pointer (the id attribute) to its content, and is lint handler would
	 * look up the DOM tree and invoke the default lint handler on that tree.
	 *
	 * FIXME: There is probably no reason for the lint handler to return anything.
	 * The caller should simply proceed with the next sibling of $rootNode
	 * after the lint handler returns.
	 *
	 * @param ParsoidExtensionAPI $extApi
	 * @param DOMElement $rootNode Extension content's root node
	 * @param callable $defaultHandler Default lint handler
	 *    - Default lint handler has signature $defaultHandler( DOMElement $elt ): void
	 * @return DOMNode|null|false Return `false` to indicate that this
	 *   extension has no special lint handler (the default lint handler will
	 *   be used.  Return `null` to indicate linting should proceed with the
	 *   next sibling.  (Deprecated) A `DOMNode` can be returned to indicate
	 *   the point in the tree where linting should resume.
	 */
	public function lintHandler(
		ParsoidExtensionAPI $extApi, DOMElement $rootNode, callable $defaultHandler
	) {
		/* Use default linter */
		return false;
	}

	/**
	 * Serialize a DOM node created by this extension to wikitext.
	 * @param DOMElement $node
	 * @param SerializerState $state
	 * @param bool $wrapperUnmodified
	 * @return string|false Return false to use the default serialization.
	 */
	public function fromHTML(
		DOMElement $node, SerializerState $state, bool $wrapperUnmodified
	) {
		/* Use default serialization */
		return false;
	}

	/**
	 * Number of newlines which should precede this tag in serialization.
	 *
	 * FIXME: Extensions should not know about anything outside their tag so
	 * this will probably be replaced by something that informs the serializer
	 * about the expected behavior on a more abstract level (such as block vs
	 * inline).
	 *
	 * @param DOMElement $node
	 * @param DOMNode $otherNode
	 * @param SerializerState $state
	 * @return array|false Return false to use the default
	 */
	public function before( DOMElement $node, DOMNode $otherNode, SerializerState $state ) {
		/* no special newlines-before behavior */
		return false;
	}

	/**
	 * Some extensions require the ability to modify the argument
	 * dictionary.
	 * @param ParsoidExtensionApi $extApi
	 * @param object $argDict
	 */
	public function modifyArgDict( ParsoidExtensionAPI $extApi, object $argDict ): void {
		/* do not modify the argument dictionary by default */
	}
}
