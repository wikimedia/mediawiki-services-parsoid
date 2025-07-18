<?php
declare( strict_types = 1 );
// @phan-file-suppress PhanEmptyPublicMethod

namespace Wikimedia\Parsoid\Ext;

use Closure;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\Element;

/**
 * A Parsoid extension module may register handlers for one or more
 * extension tags. The only method which is generally
 * required by all extension tags is `sourceToDom` (but Translate
 * doesn't even implement that).  All other methods have default do-nothing
 * implementations; override them iff you wish to implement those
 * features.  Default implementations consistently return `false`
 * to indicate not-implemented (in some cases `null` would be a
 * valid return value, and in other cases `null` would be a likely
 * "accidental" return value which we'd like to catch and flag).
 */
abstract class ExtensionTagHandler {

	/**
	 * Convert an extension tag's content to "prepared and loaded" DOM.
	 *
	 * @param ParsoidExtensionAPI $extApi
	 * @param string $content Extension tag content
	 * @param array $args Extension tag arguments
	 *   The extension tag arguments should be treated as opaque objects
	 *   and any necessary inspection should be handled through the API.
	 * @return DocumentFragment|false|null
	 *   `DocumentFragment` if returning some parsed content
	 *   `false` to fallback to the default handler for the content
	 *   `null` to drop the instance completely
	 * @throws ExtensionError
	 */
	public function sourceToDom(
		ParsoidExtensionAPI $extApi, string $content, array $args
	) {
		return false; /* Use default wrapper */
	}

	/**
	 * Extensions might embed HTML in attributes in their own custom
	 * representation (whether in data-mw or elsewhere).
	 *
	 * Core Parsoid will need a way to traverse such content. This method
	 * is a way for extension tag handlers to provide this functionality.
	 * Parsoid will only call this method if the tag's config sets the
	 * options['wt2html']['embedsHTMLInAttributes'] property to true.
	 *
	 * Override this method if your element embeds content as an HTML string;
	 * however it is recommended to embed content directly as a
	 * DocumentFragment and override ::processAttributeEmbeddedDom() instead.
	 *
	 * @param ParsoidExtensionAPI $extApi
	 * @param Element $elt The node whose data attributes need to be examined
	 * @param Closure $proc The processor that will process the embedded HTML
	 *        Signature: (string) -> string
	 *        This processor will be provided the HTML string as input
	 *        and is expected to return a possibly modified string.
	 */
	public function processAttributeEmbeddedHTML(
		ParsoidExtensionAPI $extApi, Element $elt, Closure $proc
	): void {
		// Nothing to do by default
	}

	/**
	 * Extensions might embed HTML in attributes in their own custom
	 * representation (whether in data-mw or elsewhere).
	 *
	 * Core Parsoid will need a way to traverse such content. This method
	 * is a way for extension tag handlers to provide this functionality.
	 * Parsoid will only call this method if the tag's config sets the
	 * options['wt2html']['embedsDomInAttributes'] property to true.
	 *
	 * Override this method if your element embeds
	 * content directly as a DocumentFragment, which is recommended.
	 * If your element embeds content as a serialized HTML string,
	 * then ::processAttributeEmbeddedHTML() may be more convenient.
	 *
	 * @param ParsoidExtensionAPI $extApi
	 * @param Element $elt The node whose data attributes need to be examined
	 * @param callable(DocumentFragment):bool $proc
	 *        The processor that will process the embedded HTML.
	 *        This processor will be provided a DocumentFragment
	 *        and is expected to return true if that fragment was modified.
	 */
	public function processAttributeEmbeddedDom(
		ParsoidExtensionAPI $extApi, Element $elt, callable $proc
	): void {
		// Nothing to do by default
	}

	/**
	 * Lint handler for this extension.
	 *
	 * If the extension has lints it wants to expose, it should use $extApi
	 * to register those lints. Alternatively, the extension might simply
	 * inspect its DOM and invoke the default lint handler on a DOM tree
	 * that it wants inspected. For example, <ref> nodes often only have
	 * a pointer (the id attribute) to its content, and its lint handler would
	 * look up the DOM tree and invoke the default lint handler on that tree.
	 *
	 * @param ParsoidExtensionAPI $extApi
	 * @param Element $rootNode Extension content's root node
	 * @param callable $defaultHandler Default lint handler
	 *    - Default lint handler has signature $defaultHandler( Element $elt ): void
	 * @return bool Return `false` to indicate that this
	 *   extension has no special lint handler (the default lint handler will
	 *   be used.  Return `true` to indicate linting should proceed with the
	 *   next sibling.
	 */
	public function lintHandler(
		ParsoidExtensionAPI $extApi, Element $rootNode, callable $defaultHandler
	): bool {
		/* Use default linter */
		return false;
	}

	/**
	 * Serialize a DOM node created by this extension to wikitext.
	 *
	 * @param ParsoidExtensionAPI $extApi
	 * @param Element $node A node in a "prepared and loaded" document.
	 * @param bool $wrapperUnmodified
	 * @return string|false Return false to use the default serialization.
	 */
	public function domToWikitext(
		ParsoidExtensionAPI $extApi, Element $node, bool $wrapperUnmodified
	) {
		/* Use default serialization */
		return false;
	}

	/**
	 * XXX: Experimental
	 *
	 * Call $domDiff on corresponding subtrees of $origNode and $editedNode
	 *
	 * @param ParsoidExtensionAPI $extApi
	 * @param callable $domDiff
	 * @param Element $origNode
	 * @param Element $editedNode
	 * @return bool
	 */
	public function diffHandler(
		ParsoidExtensionAPI $extApi, callable $domDiff, Element $origNode,
		Element $editedNode
	): bool {
		return false;
	}
}
