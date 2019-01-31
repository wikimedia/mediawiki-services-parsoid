<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module */

namespace Parsoid;

use Parsoid\ContentUtils as ContentUtils;
use Parsoid\DiffUtils as DiffUtils;
use Parsoid\DOMDataUtils as DOMDataUtils;
use Parsoid\DOMUtils as DOMUtils;
use Parsoid\JSUtils as JSUtils;
use Parsoid\WTUtils as WTUtils;

// These attributes are ignored for equality purposes if they are added to a node.
$ignoreAttributes = new Set( [
		// SSS: Don't ignore data-parsoid because in VE, sometimes wrappers get
		// moved around without their content which occasionally leads to incorrect
		// DSR being used by selser.  Hard to describe a reduced test case here.
		// Discovered via: /mnt/bugs/2013-05-01T09:43:14.960Z-Reverse_innovation
		// 'data-parsoid',
		'data-parsoid-diff',
		'about'
	]
);

function nextNonTemplateSibling( $node ) {
	global $WTUtils;
	return ( WTUtils::isEncapsulationWrapper( $node ) ) ? WTUtils::skipOverEncapsulatedContent( $node ) : $node->nextSibling;
}

/**
 * A DOM diff helper class.
 *
 * Compares two DOMs and annotates a copy of the passed-in DOM with change
 * information for the selective serializer.
 * @class
 * @param {MWParserEnvironment} env
 */
class DOMDiff {
	public function __construct( $env ) {
		$this->env = $env;
		$this->debug = function ( ...$args ) use ( &$env ) {return $env->log( 'trace/domdiff', ...$args );
  };
		$this->specializedAttribHandlers = JSUtils::mapObject( [
				'data-mw' => function ( $nodeA, $dmwA, $nodeB, $dmwB ) {return $this->dataMWEquals( $nodeA, $dmwA, $nodeB, $dmwB );
	   },
				'data-parsoid' => function ( $nodeA, $dpA, $nodeB, $dpB, $options ) use ( &$JSUtils ) {
					return JSUtils::deepEquals( $dpA, $dpB );
				}
			]
		);
	}
	public $env;
	public $debug;
	public $specializedAttribHandlers;

	/**
	 * Diff two HTML documents, and add / update data-parsoid-diff attributes with
	 * change information.
	 */
	public function diff( $nodeA, $nodeB ) {
		$this->domA = $nodeA->ownerDocument;
		$this->domB = $nodeB->ownerDocument;

		// The root nodes are equal, call recursive differ
		$this->debug( "ORIG:\n", $nodeA->outerHTML, "\nNEW :\n", $nodeB->outerHTML );
		$foundChange = $this->doDOMDiff( $nodeA, $nodeB );
		return [ 'isEmpty' => !$foundChange ];
	}

	/**
	 * Test if two data-mw objects are identical.
	 * - independent of order of attributes in data-mw
	 * - html attributes are parsed to DOM and recursively compared
	 * - for id attributes, the DOM fragments are fetched and compared.
	 */
	public function dataMWEquals( $nodeA, $dmwA, $nodeB, $dmwB ) {
		return $this->_dataMWEquals( $nodeA, $dmwA, $nodeB, $dmwB, [
				'isTopLevel' => true,
				'inDmwBody' => false
			]
		);
	}

	/**
	 * According to MediaWiki_DOM_spec, `id` and `html` attributes are acceptable
	 * formats in `data-mw.body` and in those contexts, they reference DOMs and
	 * we are going to treat them as such.
	 * @private
	 */
	public function _dataMWEquals( $nodeA, $dmwA, $nodeB, $dmwB, $options ) {
		$keysA = Object::keys( $dmwA );
		$keysB = Object::keys( $dmwB );

		// Some quick checks
		if ( count( $keysA ) !== count( $keysB ) ) {
			return false;
		} elseif ( count( $keysA ) === 0 ) {
			return true;
		}

		// Sort keys so we can traverse array and compare keys
		$keysA->sort();
		$keysB->sort();
		for ( $i = 0;  $i < count( $keysA );  $i++ ) {
			$kA = $keysA[ $i ];
			$kB = $keysB[ $i ];

			if ( $kA !== $kB ) {
				return false;
			}

			$vA = $dmwA[ $kA ];
			$vB = $dmwB[ $kA ];

			// Deal with null, undefined (and 0, '')
			// since they cannot be inspected
			if ( !$vA || !$vB ) {
				if ( $vA !== $vB ) {
					return false;
				}
			} elseif ( $vA->constructor !== $vB->constructor ) {
				return false;
			} elseif ( $kA === 'id' && $options->inDmwBody ) {
				// For <refs> in <references> the element id can refer to the
				// global DOM, not the owner document DOM.
				$htmlA = $nodeA->ownerDocument->getElementById( $vA )
|| $this->domA->getElementById( $vA );
				$htmlB = $nodeB->ownerDocument->getElementById( $vB )
|| $this->domB->getElementById( $vB );

				if ( $htmlA && $htmlB && !$this->treeEquals( $htmlA, $htmlB, true ) ) {
					return false;
				} elseif ( !$htmlA || !$htmlB ) {
					$type = $nodeA->getAttribute( 'typeof' );
					$match = preg_match( '/mw:Extension\/(\w+)\b/', $type );
					$extName = ( $match ) ? $match[ 1 ] : '---';
					// Log error
					if ( !$htmlA ) {
						$this->env->log( 'error/domdiff/orig/' . $extName,
							'extension src id ' . json_encode( $vA )
. ' points to non-existent element for:',
							$nodeA->outerHTML
						);
					}
					if ( !$htmlB ) {
						$this->env->log( 'error/domdiff/edited/' . $extName,
							'extension src id ' . json_encode( $vB )
. ' points to non-existent element for:',
							$nodeB->outerHTML
						);
					}

					// Fall back to default comparisons
					if ( $vA !== $vB ) {
						return false;
					}
				}
			} elseif ( $kA === 'html' && $options->inDmwBody ) {
				// For 'html' attributes, parse string and recursively compare DOM
				if ( !$this->treeEquals( ContentUtils::ppToDOM( $vA, [ 'markNew' => true ] ), ContentUtils::ppToDOM( $vB, [ 'markNew' => true ] ), true ) ) {
					return false;
				}
			} elseif ( $vA->constructor === $Object || is_array( $vA ) ) {
				// For 'array' and 'object' attributes, recursively apply _dataMWEquals
				$inDmwBody = $options->isTopLevel && $kA === 'body';
				if ( !$this->_dataMWEquals( $nodeA, $vA, $nodeB, $vB, [ 'inDmwBody' => $inDmwBody ] ) ) {
					return false;
				}
			} elseif ( $vA !== $vB ) {
				return false;
			}

			// Phew! survived this key
		}

		// Phew! survived all checks -- identical objects
		return true;
	}

	/**
	 * Test if two DOM nodes are equal.
	 * @param {Node} nodeA
	 * @param {Node} nodeB
	 * @param {boolean} deep
	 * @return bool
	 */
	public function treeEquals( $nodeA, $nodeB, $deep ) {
		if ( $nodeA->nodeType !== $nodeB->nodeType ) {
			return false;
		} elseif ( DOMUtils::isText( $nodeA ) ) {
			// In the past we've had bugs where we let non-primitive strings
			// leak into our DOM.  Safety first:
			Assert::invariant( $nodeA->nodeValue === $nodeA->nodeValue->valueOf() );
			Assert::invariant( $nodeB->nodeValue === $nodeB->nodeValue->valueOf() );
			// ok, now do the comparison.
			return $nodeA->nodeValue === $nodeB->nodeValue;
		} elseif ( DOMUtils::isComment( $nodeA ) ) {
			return WTUtils::decodeComment( $nodeA->data ) === WTUtils::decodeComment( $nodeB->data );
		} elseif ( DOMUtils::isElt( $nodeA ) ) {
			// Compare node name and attribute length
			if ( $nodeA->nodeName !== $nodeB->nodeName
|| !DiffUtils::attribsEquals( $nodeA, $nodeB, $ignoreAttributes, $this->specializedAttribHandlers )
			) {
				return false;
			}

			// Passed all tests, element node itself is equal.
			if ( $deep ) {
				$childA = null;
$childB = null;
				// Compare # of children, since that's fast.
				// (Avoid de-optimizing DOM by using node#childNodes)
				for ( $childA = $nodeA->firstChild, $childB = $nodeB->firstChild;
					$childA && $childB;
					$childA = $childA->nextSibling, $childB = $childB->nextSibling
				) {

					/* don't look inside children yet, just look at # of children */
	   }

				if ( $childA || $childB ) {
					return false; /* nodes have different # of children */
				}
				// Now actually compare the child subtrees
				for ( $childA = $nodeA->firstChild, $childB = $nodeB->firstChild;
					$childA && $childB;
					$childA = $childA->nextSibling, $childB = $childB->nextSibling
				) {
					if ( !$this->treeEquals( $childA, $childB, $deep ) ) {
						return false;
					}
				}
			}

			// Did not find a diff yet, so the trees must be equal.
			return true;
		}
	}

	/**
	 * Diff two DOM trees by comparing them node-by-node.
	 *
	 * TODO: Implement something more intelligent like
	 * http://gregory.cobena.free.fr/www/Publications/%5BICDE2002%5D%20XyDiff%20-%20published%20version.pdf,
	 * which uses hash signatures of subtrees to efficiently detect moves /
	 * wrapping.
	 *
	 * Adds / updates a data-parsoid-diff structure with change information.
	 *
	 * Returns true if subtree is changed, false otherwise.
	 *
	 * TODO:
	 * Assume typical CSS white-space, so ignore ws diffs in non-pre content.
	 */
	public function doDOMDiff( $baseParentNode, $newParentNode ) {
		$dd = $this;

		function debugOut( $nodeA, $nodeB, $laPrefix ) use ( &$dd, &$DOMUtils ) {
			$laPrefix = $laPrefix || '';
			$dd->env->log( 'trace/domdiff', function () use ( &$laPrefix, &$DOMUtils, &$nodeA ) {
					return '--> A' . $laPrefix . ':' . ( ( DOMUtils::isElt( $nodeA ) ) ? $nodeA->outerHTML : json_encode( $nodeA->nodeValue ) );
			}
			);
			$dd->env->log( 'trace/domdiff', function () use ( &$laPrefix, &$DOMUtils, &$nodeB ) {
					return '--> B' . $laPrefix . ':' . ( ( DOMUtils::isElt( $nodeB ) ) ? $nodeB->outerHTML : json_encode( $nodeB->nodeValue ) );
			}
			);
		}

		// Perform a relaxed version of the recursive treeEquals algorithm that
		// allows for some minor differences and tries to produce a sensible diff
		// marking using heuristics like look-ahead on siblings.
		$baseNode = $baseParentNode->firstChild;
		$newNode = $newParentNode->firstChild;
		$lookaheadNode = null;
		$subtreeDiffers = null;
		$foundDiffOverall = false;
		$dontAdvanceNewNode = false;

		while ( $baseNode && $newNode ) {
			$dontAdvanceNewNode = false;
			debugOut( $baseNode, $newNode );
			// shallow check first
			if ( !$this->treeEquals( $baseNode, $newNode, false ) ) {
				$this->debug( '-- not equal --' );
				$savedNewNode = $newNode;
				$foundDiff = false;

				// Some simplistic look-ahead, currently limited to a single level
				// in the DOM.

				// look-ahead in *new* DOM to detect insertions
				if ( DOMUtils::isContentNode( $baseNode ) ) {
					$this->debug( '--lookahead in new dom--' );
					$lookaheadNode = $newNode->nextSibling;
					while ( $lookaheadNode ) {
						debugOut( $baseNode, $lookaheadNode, 'new' );
						if ( DOMUtils::isContentNode( $lookaheadNode )
&& $this->treeEquals( $baseNode, $lookaheadNode, true )
						) {
							// mark skipped-over nodes as inserted
							$markNode = $newNode;
							while ( $markNode !== $lookaheadNode ) {
								$this->debug( '--found diff: inserted--' );
								$this->markNode( $markNode, 'inserted' );
								$markNode = $markNode->nextSibling;
							}
							$foundDiff = true;
							$newNode = $lookaheadNode;
							break;
						}
						$lookaheadNode = nextNonTemplateSibling( $lookaheadNode );
					}
				}

				// look-ahead in *base* DOM to detect deletions
				if ( !$foundDiff && DOMUtils::isContentNode( $newNode ) ) {
					$isBlockNode = WTUtils::isBlockNodeWithVisibleWT( $baseNode );
					$this->debug( '--lookahead in old dom--' );
					$lookaheadNode = $baseNode->nextSibling;
					while ( $lookaheadNode ) {
						debugOut( $lookaheadNode, $newNode, 'old' );
						if ( DOMUtils::isContentNode( $lookaheadNode )
&& $this->treeEquals( $lookaheadNode, $newNode, true )
						) {
							$this->debug( '--found diff: deleted--' );
							// mark skipped-over nodes as deleted
							$this->markNode( $newNode, 'deleted', $isBlockNode );
							$baseNode = $lookaheadNode;
							$foundDiff = true;
							break;
						} elseif ( !WTUtils::emitsSolTransparentSingleLineWT( $lookaheadNode ) ) {
							// We only care about the deleted node prior to the one that
							// gets a tree match (but, ignore nodes that show up in wikitext
							// but don't affect sol-state or HTML rendering -- note that
							// whitespace is being ignored, but that whitespace occurs
							// between block nodes).
							$isBlockNode = WTUtils::isBlockNodeWithVisibleWT( $lookaheadNode );
						}
						$lookaheadNode = nextNonTemplateSibling( $lookaheadNode );
					}
				}

				if ( !$foundDiff ) {
					if ( !DOMUtils::isElt( $savedNewNode ) ) {
						$this->debug( '--found diff: modified text/comment--' );
						$this->markNode( $savedNewNode, 'deleted', WTUtils::isBlockNodeWithVisibleWT( $baseNode ) );
					} elseif ( $savedNewNode->nodeName === $baseNode->nodeName
&& DOMDataUtils::getDataParsoid( $savedNewNode )->stx === DOMDataUtils::getDataParsoid( $baseNode )->stx
					) {
						// Identical wrapper-type, but modified.
						// Mark modified-wrapper, and recurse.
						$this->debug( '--found diff: modified-wrapper--' );
						$this->markNode( $savedNewNode, 'modified-wrapper' );
						if ( !WTUtils::isEncapsulationWrapper( $baseNode )
&& !WTUtils::isEncapsulationWrapper( $savedNewNode )
						) {
							// Dont recurse into template-like-content
							$subtreeDiffers = $this->doDOMDiff( $baseNode, $savedNewNode );
							if ( $subtreeDiffers ) {
								$this->debug( '--found diff: subtree-changed--' );
								$this->markNode( $newNode, 'subtree-changed' );
							}
						}
					} else {
						// We now want to compare current newNode with the next baseNode.
						$dontAdvanceNewNode = true;

						// Since we are advancing in an old DOM without advancing
						// in the new DOM, there were deletions. Add a deletion marker
						// since this is important for accurate separator handling in selser.
						$this->markNode( $savedNewNode, 'deleted', WTUtils::isBlockNodeWithVisibleWT( $baseNode ) );
					}
				}

				// Record the fact that direct children changed in the parent node
				$this->debug( '--found diff: children-changed--' );
				$this->markNode( $newParentNode, 'children-changed' );

				$foundDiffOverall = true;
			} elseif ( !WTUtils::isEncapsulationWrapper( $baseNode ) && !WTUtils::isEncapsulationWrapper( $newNode ) ) {
				$this->debug( '--shallow equal: recursing--' );
				// Recursively diff subtrees if not template-like content
				$subtreeDiffers = $this->doDOMDiff( $baseNode, $newNode );
				if ( $subtreeDiffers ) {
					$this->debug( '--found diff: subtree-changed--' );
					$this->markNode( $newNode, 'subtree-changed' );
				}
				$foundDiffOverall = $subtreeDiffers || $foundDiffOverall;
			}

			// And move on to the next pair (skipping over template HTML)
			if ( $baseNode && $newNode ) {
				$baseNode = nextNonTemplateSibling( $baseNode );
				if ( !$dontAdvanceNewNode ) {
					$newNode = nextNonTemplateSibling( $newNode );
				}
			}
		}

		// mark extra new nodes as inserted
		while ( $newNode ) {
			$this->debug( '--found trailing new node: inserted--' );
			$this->markNode( $newNode, 'inserted' );
			$foundDiffOverall = true;
			$newNode = nextNonTemplateSibling( $newNode );
		}

		// If there are extra base nodes, something was deleted. Mark the parent as
		// having lost children for now.
		if ( $baseNode ) {
			$this->debug( '--found trailing base nodes: deleted--' );
			$this->markNode( $newParentNode, 'children-changed' );
			// SSS FIXME: WTS checks for zero children in a few places
			// That code would have to be upgraded if we emit mw:DiffMarker
			// in this scenario. So, bailing out in this one case for now.
			if ( $newParentNode->hasChildNodes() ) {
				$meta = $newParentNode->ownerDocument->createElement( 'meta' );
				$meta->setAttribute( 'typeof', 'mw:DiffMarker/deleted' );
				if ( WTUtils::isBlockNodeWithVisibleWT( $baseNode ) ) {
					$meta->setAttribute( 'data-is-block', 'true' );
				}
				$newParentNode->appendChild( $meta );
			}
			$foundDiffOverall = true;
		}

		return $foundDiffOverall;
	}

	/* ***************************************************
	 * Helpers
	 * ***************************************************/

	/** @private */
	public function markNode( $node, $mark, $blockNodeDeleted ) {
		$meta = null;
		if ( $mark === 'deleted' ) {
			// insert a meta tag marking the place where content used to be
			$meta = DiffUtils::prependTypedMeta( $node, 'mw:DiffMarker/' . $mark );
		} else {
			if ( DOMUtils::isElt( $node ) ) {
				DiffUtils::setDiffMark( $node, $this->env, $mark );
			} elseif ( DOMUtils::isText( $node ) || DOMUtils::isComment( $node ) ) {
				if ( $mark !== 'inserted' ) {
					$this->env->log( 'error/domdiff',
						'BUG! CHANGE-marker for ' . $node->nodeType . ' node is: ' . $mark
					);
				}
				$meta = DiffUtils::prependTypedMeta( $node, 'mw:DiffMarker/' . $mark );
			} elseif ( $node->nodeType !== $node::DOCUMENT_NODE
&& $node->nodeType !== $node::DOCUMENT_TYPE_NODE
			) {
				$this->env->log( 'error/domdiff', 'Unhandled node type', $node->nodeType, 'in markNode!' );
			}
		}

		if ( $meta && $blockNodeDeleted ) {
			$meta->setAttribute( 'data-is-block', 'true' );
		}

		if ( $mark === 'deleted' || $mark === 'inserted' ) {
			$this->markNode( $node->parentNode, 'children-changed' );
		}
	}
}

if ( gettype( $module ) === 'object' ) {
	$module->exports->DOMDiff = $DOMDiff;
}
