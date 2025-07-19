<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext;

use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\Fragments\PFragment;

/**
 * A Parsoid extension module may register handlers for one or more
 * fragment generators.  Fragment generators can use parser function
 * or (TODO: T390342) extension tag syntax.
 *
 * The only method which is generally required by all fragment
 * generators is `sourceToFragment`.  All other methods have default
 * do-nothing implementations; override them if you wish to implement
 * those features.  Default implementations consistently return
 * `false` to indicate not-implemented, since in some cases `null`
 * would be a valid return value, and in other cases `null` would be a
 * likely "accidental" return value which we'd like to catch and flag.
 *
 * PFragmentHandler supplies lazy (unexpanded) arguments using the
 * Arguments interface.  Argument values can be evaluated eagerly
 * (expanded) using PFragment::expand().  The Arguments interface
 * provides for interpreting the argument list either as named or
 * positional arguments, and provides a convenient way to access
 * expanded and trimmed values.
 *
 * When using the extension tag syntax the arguments will be presented
 * as if the equivalent {{#tag:...}}  function were invoked; in
 * particular the tag contents will be presented as the first ordered
 * argument, with attributes provided as named arguments following it.
 *
 * Note that the legacy parser presented arguments in lazy/unexpanded
 * form for extension tag syntax but by default (unless
 * SFH_OBJECT_ARGS was passed) presented arguments in eager/expanded
 * form for parser function syntax.  The legacy parser also provided
 * "named arguments" (ie attributes) for extension tag syntax, but
 * only "positional arguments" for parser function syntax, although
 * implementers often reimplemented named-argument parsing in their
 * own code.
 *
 * Implementers should be aware of the historical convention that
 * extension tag syntax corresponds to lazy/named/unexpanded and that
 * parser function syntax corresponds to eager/positional/expanded,
 * although the Arguments interface can provide both behaviors
 * regardless of syntax.
 */
abstract class PFragmentHandler {

	/**
	 * Convert an fragment generator's content to a PFragment.
	 * Note that the returned fragment may also contain metadata,
	 * collected via $extApi->getMetadata() (a ContentMetadataCollector).
	 * @param ParsoidExtensionAPI $extApi
	 * @param Arguments $arguments The arguments of
	 *  the fragment.
	 * @param bool $tagSyntax True if this PFragment handler was invoked using
	 *  extension tag syntax; false if parser function syntax was used
	 *  (including {{#tag:}}).
	 * @return PFragment|AsyncResult
	 *  - `PFragment` if returning some parsed content
	 *  - `AsyncResult` if the asynchronous source is "not ready yet"
	 *     to return content.
	 */
	abstract public function sourceToFragment(
		ParsoidExtensionAPI $extApi,
		Arguments $arguments,
		bool $tagSyntax
	);

	/**
	 * Extensions might embed HTML in attributes in their own custom
	 * representation (whether in data-mw or elsewhere).
	 *
	 * Core Parsoid will need a way to traverse such content. This method
	 * is a way for extension tag handlers to provide this functionality.
	 * Parsoid will only call this method if the tag's config sets the
	 * options['wt2html']['embedsDomInAttributes'] property to true.
	 *
	 * @param ParsoidExtensionAPI $extApi
	 * @param Element $elt The node whose data attributes need to be examined
	 * @param callable(DocumentFragment):bool $proc The processor that will
	 *        process the embedded HTML
	 *        Signature: (DocumentFragment) -> bool
	 *        This processor will be provided the DocumentFragment as input
	 *        and is expected to return true if the given fragment is modified.
	 * @return bool Whether or not changes were made to the embedded fragments
	 */
	public function processAttributeEmbeddedDom(
		ParsoidExtensionAPI $extApi, Element $elt, callable $proc
	): bool {
		// Introduced in If14a86645b9feb5b3d9503e3037de403e588d65d
		// Nothing to do by default
		return false;
	}

	/**
	 * Lint handler for this fragment generator.
	 *
	 * If the fragment generator has lints it wants to expose, it should use $extApi
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
	 * @param Element $node
	 * @param bool $wrapperUnmodified
	 * @param ?bool $tagSyntax True if using extension tag syntax, false to
	 *  use parser function syntax, null allows implementer to choose.
	 * @return string|false Return false to use the default serialization.
	 */
	public function domToSource(
		ParsoidExtensionAPI $extApi, Element $node,
		bool $wrapperUnmodified, ?bool $tagSyntax
	) {
		// TODO (T390343)
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
/** @deprecated since 0.21 */
class_alias( PFragmentHandler::class, '\Wikimedia\Parsoid\Ext\FragmentHandler' );
