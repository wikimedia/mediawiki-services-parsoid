<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * Pre-order depth-first DOM traversal helper.
 * @module
 */

namespace Parsoid;

$DOMDataUtils = require './DOMDataUtils.js'::DOMDataUtils;
$DOMUtils = require './DOMUtils.js'::DOMUtils;
$JSUtils = require './jsutils.js'::JSUtils;
$WTUtils = require './WTUtils.js'::WTUtils;

/**
 * Class for helping us traverse the DOM.
 *
 * This class currently does a pre-order depth-first traversal.
 * See {@link DOMPostOrder} for post-order traversal.
 *
 * @class
 * @param {MWParserEnvironment} env
 * @param {boolean} skipCheckIfAttached
 */
function DOMTraverser( $env, $skipCheckIfAttached ) {
	$this->handlers = [];
	$this->env = $env;
	$this->checkIfAttached = !$skipCheckIfAttached;
}

/**
 * DOM traversal handler.
 * @callback module:utils/DOMTraverser~traverserHandler
 * @param {Node} node
 * @param {MWParserEnvironment} env
 * @param {boolean} atTopLevel
 * @param {Object} tplInfo Template information.
 * @return {Node|null|false|true}
 *   Return false if you want to stop any further callbacks from being
 *   called on the node.  Return the new node if you need to replace it or
 *   change its siblings; traversal will continue with the new node.
 */

/**
 * Add a handler to the DOM traverser.
 *
 * @param {string} nodeName
 * @param {traverserHandler} action
 *   A callback, called on each node we traverse that matches nodeName.
 * @param {Object} [context]
 *   A context object to use when the `action` is invoked.
 */
DOMTraverser::prototype::addHandler = function ( $nodeName, $action, $context ) {
	$this->handlers[] = [ 'action' => $action, 'nodeName' => $nodeName, 'context' => $context ];
};

/**
 * @private
 */
DOMTraverser::prototype::callHandlers = function ( $node, $env, $atTopLevel, $tplInfo ) use ( &$DOMUtils ) {
	$name = strtolower( $node->nodeName || '' );
	$document = $node->ownerDocument;

	foreach ( $this->handlers as $handler => $___ ) {
		if ( $handler->nodeName === null || $handler->nodeName === $name ) {
			$result = call_user_func( [ $handler, 'action' ], $node, $env, $atTopLevel, $tplInfo );
			if ( $result !== true ) {
				if ( $result === null ) {
					$this->env->log( 'error',
						'DOMPostProcessor.traverse: undefined return!',
						'Bug in', $handler->action->toString(),
						' when handling ', $node->outerHTML
					);
				}
				// abort processing for this node
				return $result;
			}

			// Sanity check for broken handlers
			if ( $this->checkIfAttached && !DOMUtils::isAncestorOf( $document, $node ) ) {
				$console->error( 'DOMPostProcessor.traverse: detached node. '
. 'Bug in ' . $handler->action->toString()
. ' when handling', $node->outerHTML
				);
			}
		}
	}

	return true;
};

/**
 * Traverse the DOM and fire the handlers that are registered.
 *
 * Handlers can return
 * - the next node to process
 *   - aborts processing for current node, continues with returned node
 *   - can also be `null`, so returning `workNode.nextSibling` works even when
 *     workNode is a last child of its parent
 * - `true`
 *   - continue regular processing on current node.
 *
 * @param {Node} workNode
 * @param {MWParserEnvironment} env
 * @param {Object} options
 * @param {boolean} atTopLevel
 * @param {Object} tplInfo Template information.
 * @return {Node|null|true}
 */
DOMTraverser::prototype::traverse = function ( $workNode, $env, $options, $atTopLevel, $tplInfo ) use ( &$DOMUtils, &$WTUtils, &$JSUtils, &$DOMDataUtils ) {
	while ( $workNode !== null ) {
		if ( DOMUtils::isElt( $workNode ) ) {
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
				$about = $workNode->getAttribute( 'about' ) || '';
				$tplInfo = [
					'first' => $workNode,
					'last' => JSUtils::lastItem( WTUtils::getAboutSiblings( $workNode, $about ) ),
					'dsr' => DOMDataUtils::getDataParsoid( $workNode )->dsr,
					'clear' => false
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
};

if ( gettype( $module ) === 'object' ) {
	$module->exports->DOMTraverser = $DOMTraverser;
}
