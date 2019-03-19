<?php
declare( strict_types = 1 );

namespace Parsoid\Utils;

use Closure;
use DOMElement;
use DOMNode;
use Parsoid\Config\Env;
use StdClass;

/**
 * Class for helping us traverse the DOM.
 *
 * This class currently does a pre-order depth-first traversal.
 * See {@link DOMPostOrder} for post-order traversal.
 */
class DOMTraverser {
	/**
	 * List of handlers to call on each node. Each handler is an array with the following fields:
	 * - action: a callable to call
	 * - nodeName: if set, only call it on nodes with this name
	 * @var array
	 * @see addHandler()
	 */
	// Porting note: due to language differences, the 'context' field is incorporated into 'action'.
	private $handlers;

	/** @var Env */
	// PORT-FIXME seems pointless, the Env passed into traverse() gets used instead
	private $env;

	/** @var bool If true, do not verify whether the current node is attached to the document. */
	private $checkIfAttached;

	/**
	 * @param Env $env
	 * @param bool $skipCheckIfAttached If true, do not verify whether the current node is
	 *   attached to the document.
	 */
	public function __construct( Env $env, bool $skipCheckIfAttached ) {
		$this->handlers = [];
		$this->env = $env;
		$this->checkIfAttached = !$skipCheckIfAttached;
	}

	/**
	 * Add a handler to the DOM traverser.
	 *
	 * @param string|null $nodeName An optional node name filter
	 * @param callable $action A callback, called on each node we traverse that matches nodeName.
	 *   Will be called with the following parameters:
	 *   - DOMNode $node: the node being processed
	 *   - Env $env: the parser environment
	 *   - bool $atTopLevel: passed through from DOMTraverser::traverse
	 *   - StdClass $tplInfo: Template information. See traverse().
	 *   Return value: DOMNode|null|true.
	 *   - true: proceed normally
	 *   - DOMNode: traversal will continue on the new node (further handlers will not be called
	 *     on the current node); after processing it and its siblings, it will continue with the
	 *     next sibling of the closest ancestor which has one.
	 *   - null: like the DOMNode case, except there is no new node to process before continuing.
	 * @param object|null $context A context object to use when the `action` is invoked.
	 *   PORT-FIMXE: is this useful in PHP?
	 */
	public function addHandler( ?string $nodeName, callable $action, object $context = null ): void {
		if ( $context ) {
			$action = Closure::fromCallable( $action );
			$action->bindTo( $context );
		}
		$this->handlers[] = [ 'action' => $action, 'nodeName' => $nodeName ];
	}

	/**
	 * @param DOMNode $node
	 * @param Env $env
	 * @param bool $atTopLevel ???
	 * @param StdClass|null $tplInfo
	 * @return bool|mixed
	 */
	private function callHandlers( DOMNode $node, Env $env, bool $atTopLevel, ?StdClass $tplInfo ) {
		$name = $node->nodeName ?: '';
		$document = $node->ownerDocument;

		foreach ( $this->handlers as $handler ) {
			if ( $handler['nodeName'] === null || $handler['nodeName'] === $name ) {
				$result = call_user_func( $handler['action'], $node, $env, $atTopLevel, $tplInfo );
				if ( $result !== true ) {
					// PORT-FIXME the original code had an assertion against undefined return.
					// PHP cannot differentiate between no return and null return (which is
					// valid here). Ignore or change semantics to catch no explicit return?

					// abort processing for this node
					return $result;
				}

				// Sanity check for broken handlers
				if ( $this->checkIfAttached && !DOMUtils::isAncestorOf( $document, $node ) ) {
					// PORT-FIXME this was a plain console.log in the original
					// PORT-FIXME if we keep this, add a helper for turning callable into name
					// PORT-FIXME is $node guaranteed to be an element?
					$env->log( 'error', 'DOMPostProcessor.traverse: detached node. Bug in '
						. '[callback] when handling' . ( $node->nodeType === XML_ELEMENT_NODE
						? DOMCompat::getOuterHTML( $node ) : '???' ) );
				}
			}
		}

		return true;
	}

	/**
	 * Traverse the DOM and fire the handlers that are registered.
	 *
	 * Handlers can return
	 * - the next node to process: aborts processing for current node (ie. no further handlers are
	 *   called) and continues processing on returned node. Essentially, that node and its siblings
	 *   replace the current node and its siblings for the purposes of the traversal; after they
	 *   are fully processed, the algorithm moves back to the parent of $workNode to look for
	 *   the next sibling.
	 *   PORT-FIXME did the old logic relied on being able to set next sibling? that attribute is
	 *   not writable in PHP (or the DOM spec)
	 * - `null`: same as above, except it continues from the next sibling of the parent (or if
	 *   that does not exist, the next sibling of the grandparent etc). This is so that returning
	 *   `$workNode->nextSibling` works even when workNode is a last child of its parent.
	 * - `true`: continues regular processing on current node.
	 *
	 * @param DOMNode $workNode The root node for the traversal.
	 * @param Env $env
	 * @param array $options PORT-FIXME not used?
	 * @param bool $atTopLevel ???
	 * @param StdClass|null $tplInfo Template information. When set, it must have all of these fields:
	 *   - first: (DOMNode) first sibling
	 *   - last: (DOMNode) last sibling
	 *   - dsr: field from Pasoid ino
	 *   - clear: when set, the template will not be passed along for further processing
	 * @return DOMNode|null|true PORT-FIXME does not actually return anything...
	 */
	public function traverse(
		DOMNode $workNode, Env $env, array $options, bool $atTopLevel, ?StdClass $tplInfo
	) {
		while ( $workNode !== null ) {
			if ( DOMUtils::isElt( $workNode ) ) {
				/** @var DOMElement $workNode */

				// Identify the first template/extension node.
				// You'd think the !tplInfo check isn't necessary since
				// we don't have nested transclusions, however, you can
				// get extensions in transclusions.
				if ( !$tplInfo && WTUtils::isFirstEncapsulationWrapperNode( $workNode )
					// Encapsulation info on sections should not be used to
					// traverse with since it's designed to be dropped and
					// may have expanded ranges.
					&& !WTUtils::isParsoidSectionTag( $workNode )
				) {
					$about = $workNode->getAttribute( 'about' ) ?: '';
					$tplInfo = (object)[
						'first' => $workNode,
						'last' => PHPUtils::lastItem( WTUtils::getAboutSiblings( $workNode, $about ) ),
						'dsr' => DOMDataUtils::getDataParsoid( $workNode )->dsr,
						'clear' => false,
					];
				}
			}

			// Call the handlers on this workNode
			$possibleNext = $this->callHandlers( $workNode, $env, $atTopLevel, $tplInfo );

			// We may have walked passed the last about sibling or want to
			// ignore the template info in future processing.
			if ( $tplInfo && $tplInfo->clear ) {
				$tplInfo = null;
			}

			if ( $possibleNext === true ) {
				// the 'continue processing' case
				if ( DOMUtils::isElt( $workNode ) && $workNode->hasChildNodes() ) {
					$this->traverse( $workNode->firstChild, $env, $options, $atTopLevel, $tplInfo );
				}
				$possibleNext = $workNode->nextSibling;
			}

			// Clear the template info after reaching the last about sibling.
			if ( $tplInfo && $tplInfo->last === $workNode ) {
				$tplInfo = null;
			}

			$workNode = $possibleNext;
		}
	}

}
