<?php
declare( strict_types = 1 );

namespace Parsoid\Ext;

use DOMDocument;
use DOMElement;
use DOMNode;
use Parsoid\Config\ParsoidExtensionAPI;

interface ExtensionTag {
	/**
	 * Convert an extension tag to DOM.
	 * @param ParsoidExtensionAPI $extApi
	 * @param string $txt Extension tag contents
	 * @param array $extArgs Extension tag arguments
	 * @return DOMDocument
	 */
	public function toDOM( ParsoidExtensionAPI $extApi, string $txt, array $extArgs ): DOMDocument;

	/**
	 * Does this extension support linting for its content?
	 * If so, it should implement the lintHandler
	 * @return bool
	 */
	public function hasLintHandler(): bool;

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
	 * @return DOMNode|null
	 */
	public function lintHandler(
		ParsoidExtensionAPI $extApi, DOMElement $rootNode, callable $defaultHandler
	): ?DOMNode;
}
