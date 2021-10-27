<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Html2Wt;

use stdClass;
use Wikimedia\Assert\Assert;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\DOM\Comment;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\DOM\Text;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Utils\WTUtils;

/**
 * A DOM diff helper class.
 *
 * Compares two DOMs and annotates a copy of the passed-in DOM with change
 * information for the selective serializer.
 */
class DOMDiff {

	// These attributes are ignored for equality purposes if they are added to a node.
	private const IGNORE_ATTRIBUTES = [
		// Note that we are explicitly not ignoring data-parsoid even though clients
		// would never modify data-parsoid because SelectiveSerializer is wrapping text
		// nodes in spans and speculatively computes DSR offsets for these span tags
		// which are accurate for original DOM and may be inaccurate for the edited DOM.
		// By diffing data-parsoid which diffs the DSR as well, we ensure we mark such
		// nodes as modified and prevent use of those speculatively computed incorrect
		// DSR values.
		'data-parsoid-diff',
		'about',
		DOMDataUtils::DATA_OBJECT_ATTR_NAME,
	];

	/**
	 * @var Env
	 */
	public $env;

	/**
	 * @var array
	 */
	public $specializedAttribHandlers;

	/**
	 * @param Node $node
	 * @return Node|null
	 */
	private function nextNonTemplateSibling( Node $node ): ?Node {
		if ( WTUtils::isEncapsulationWrapper( $node ) ) {
			return WTUtils::skipOverEncapsulatedContent( $node );
		}
		return $node->nextSibling;
	}

	/**
	 * @param mixed ...$args
	 */
	private function debug( ...$args ): void {
		$this->env->log( 'trace/domdiff', ...$args );
	}

	/**
	 * @param Env $env
	 */
	public function __construct( Env $env ) {
		$this->env = $env;
		$this->specializedAttribHandlers = [
			'data-mw' => function ( $nodeA, $dmwA, $nodeB, $dmwB ) {
				return $this->dataMWEquals( $nodeA, $dmwA, $nodeB, $dmwB );
			},
			'data-parsoid' => static function ( $nodeA, $dpA, $nodeB, $dpB ) {
				return $dpA == $dpB;
			},
			// TODO(T254502): This is added temporarily for backwards
			// compatibility and can be removed when versions up to 2.1.0
			// are no longer stored
			'typeof' => static function ( $nodeA, $valA, $nodeB, $valB ) {
				if ( $valA === $valB ) {
					return true;
				} elseif ( $valA === 'mw:DisplaySpace' ) {
					return $valB === 'mw:DisplaySpace mw:Placeholder';
				} elseif ( $valB === 'mw:DisplaySpace' ) {
					return $valA === 'mw:DisplaySpace mw:Placeholder';
				} else {
					return false;
				}
			}
		];
	}

	/**
	 * Diff two HTML documents, and add / update data-parsoid-diff attributes with
	 * change information.
	 *
	 * @param Element $nodeA
	 * @param Element $nodeB
	 * @return array
	 */
	public function diff( Element $nodeA, Element $nodeB ): array {
		Assert::invariant(
			$nodeA->ownerDocument !== $nodeB->ownerDocument,
			'Expected to be diff\'ing different documents.'
		);

		$this->debug( static function () use( $nodeA, $nodeB ) {
			return "ORIG:\n" .
				DOMCompat::getOuterHTML( $nodeA ) .
				"\nNEW :\n" .
				DOMCompat::getOuterHTML( $nodeB );
		} );

		// The root nodes are equal, call recursive differ
		$foundChange = $this->doDOMDiff( $nodeA, $nodeB );
		return [ 'isEmpty' => !$foundChange ];
	}

	/**
	 * Test if two data-mw objects are identical.
	 * - independent of order of attributes in data-mw
	 * - html attributes are parsed to DOM and recursively compared
	 * - for id attributes, the DOM fragments are fetched and compared.
	 *
	 * @param Node $nodeA
	 * @param stdClass $dmwA
	 * @param Node $nodeB
	 * @param stdClass $dmwB
	 * @return bool
	 */
	public function dataMWEquals(
		Node $nodeA, stdClass $dmwA, Node $nodeB, stdClass $dmwB
	): bool {
		return $this->realDataMWEquals( $nodeA, (array)$dmwA, $nodeB, (array)$dmwB, [
				'atJsonRoot' => true,
				'inDmwBody' => false
			]
		);
	}

	/**
	 * According to [[mw:Specs/HTML]], `id` and `html` attributes are acceptable
	 * formats in `data-mw.body` and in those contexts, they reference DOMs and
	 * we are going to treat them as such.
	 *
	 * @param Node $nodeA
	 * @param array $dmwA
	 * @param Node $nodeB
	 * @param array $dmwB
	 * @param array $options
	 * @return bool
	 */
	private function realDataMWEquals(
		Node $nodeA, array $dmwA, Node $nodeB, array $dmwB, array $options
	): bool {
		$keysA = array_keys( $dmwA );
		$keysB = array_keys( $dmwB );

		// Some quick checks
		if ( count( $keysA ) !== count( $keysB ) ) {
			return false;
		} elseif ( count( $keysA ) === 0 ) {
			return true;
		}

		// Sort keys so we can traverse array and compare keys
		sort( $keysA );
		sort( $keysB );
		for ( $i = 0; $i < count( $keysA ); $i++ ) {
			$kA = $keysA[$i];
			$kB = $keysB[$i];

			if ( $kA !== $kB ) {
				return false;
			}

			$vA = $dmwA[$kA];
			$vB = $dmwB[$kA];

			// Deal with null, undefined (and 0, '')
			// since they cannot be inspected
			if ( !$vA || !$vB ) {
				if ( $vA !== $vB ) {
					return false;
				}
			} elseif ( gettype( $vA ) !== gettype( $vB ) ) {
				return false;
			} elseif ( $kA === 'id' && ( $options['inDmwBody'] ?? null ) ) {
				// So far, this is specified for Cite and relies on the "id"
				// referring to an element in the top level dom, even though the
				// <ref> itself may be in embedded content,
				// https://www.mediawiki.org/wiki/Specs/HTML/Extensions/Cite#Ref_and_References
				// FIXME: This doesn't work if the <references> section
				// itself is in embedded content, since we aren't traversing
				// in there.
				$htmlA = DOMCompat::getElementById( $nodeA->ownerDocument, $vA );
				$htmlB = DOMCompat::getElementById( $nodeB->ownerDocument, $vB );

				if ( $htmlA && $htmlB && !$this->treeEquals( $htmlA, $htmlB, true ) ) {
					return false;
				} elseif ( !$htmlA || !$htmlB ) {
					$type = DOMUtils::matchTypeOf( $nodeA, '#^mw:Extension/#' );
					$extName = $type ? '---' : substr( $type, strlen( 'mw:Extension/' ) );
					// Log error
					if ( !$htmlA ) {
						$this->env->log(
							'error/domdiff/orig/' . $extName,
							'extension src id ' . PHPUtils::jsonEncode( $vA ) . ' points to non-existent element for:',
							DOMUtils::assertElt( $nodeA ) && DOMCompat::getOuterHTML( $nodeA )
						);
					}
					if ( !$htmlB ) {
						$this->env->log(
							'error/domdiff/edited/' . $extName,
							'extension src id ' . PHPUtils::jsonEncode( $vB ) . ' points to non-existent element for:',
							DOMUtils::assertElt( $nodeB ) && DOMCompat::getOuterHTML( $nodeB )
						);
					}

					// Fall back to default comparisons
					if ( $vA !== $vB ) {
						return false;
					}
				}
			} elseif ( $kA === 'html' && ( $options['inDmwBody'] ?? null ) ) {
				// It's important that the fragments are constructed from the
				// correct node's ownerDocument so that the search by id above
				// is looking in the right place
				$fragmentA = ContentUtils::createAndLoadDocumentFragment(
					$nodeA->ownerDocument, $vA, [ 'markNew' => true ]
				);
				$fragmentB = ContentUtils::createAndLoadDocumentFragment(
					$nodeB->ownerDocument, $vB, [ 'markNew' => true ]
				);
				// For 'html' attributes, parse string and recursively compare DOM
				if ( !$this->treeEquals( $fragmentA, $fragmentB, true ) ) {
					return false;
				}
			} elseif ( is_object( $vA ) || is_array( $vA ) ) {
				// For 'array' and 'object' attributes, recursively apply _dataMWEquals
				$inDmwBody = ( $options['atJsonRoot'] ?? null ) && $kA === 'body';
				if ( !$this->realDataMWEquals(
					$nodeA,
					(array)$vA,
					$nodeB,
					(array)$vB,
					[ 'inDmwBody' => $inDmwBody ]
				) ) {
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
	 *
	 * @param Node $nodeA
	 * @param Node $nodeB
	 * @param bool $deep
	 * @return bool
	 */
	public function treeEquals( Node $nodeA, Node $nodeB, bool $deep ): bool {
		if ( $nodeA->nodeType !== $nodeB->nodeType ) {
			return false;
		} elseif ( $nodeA instanceof Text ) {
			// In the past we've had bugs where we let non-primitive strings
			// leak into our DOM.  Safety first:
			Assert::invariant( $nodeA->nodeValue === (string)$nodeA->nodeValue, '' );
			Assert::invariant( $nodeB->nodeValue === (string)$nodeB->nodeValue, '' );
			// ok, now do the comparison.
			return $nodeA->nodeValue === $nodeB->nodeValue;
		} elseif ( $nodeA instanceof Comment ) {
			return WTUtils::decodeComment( $nodeA->nodeValue ) ===
				WTUtils::decodeComment( $nodeB->nodeValue );
		} elseif ( $nodeA instanceof Element || $nodeA instanceof DocumentFragment ) {
			if ( $nodeA instanceof DocumentFragment ) {
				if ( !( $nodeB instanceof DocumentFragment ) ) {
					return false;
				}
			} else {  // $nodeA instanceof Element
				// Compare node name and attribute length
				if (
					!( $nodeB instanceof Element ) ||
					DOMCompat::nodeName( $nodeA ) !== DOMCompat::nodeName( $nodeB ) ||
					!DiffUtils::attribsEquals(
						$nodeA,
						$nodeB,
						self::IGNORE_ATTRIBUTES,
						$this->specializedAttribHandlers
					)
				) {
					return false;
				}
			}

			// Passed all tests, node itself is equal.
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
		PHPUtils::unreachable( 'we shouldn\'t get here' );
		return false;
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
	 *
	 * @param Node $baseParentNode
	 * @param Node $newParentNode
	 * @return bool
	 */
	public function doDOMDiff( Node $baseParentNode, Node $newParentNode ): bool {
		// Perform a relaxed version of the recursive treeEquals algorithm that
		// allows for some minor differences and tries to produce a sensible diff
		// marking using heuristics like look-ahead on siblings.
		$baseNode = $baseParentNode->firstChild;
		$newNode = $newParentNode->firstChild;
		$lookaheadNode = null;
		$foundDiffOverall = false;

		while ( $baseNode && $newNode ) {
			$dontAdvanceNewNode = false;
			$this->debugOut( $baseNode, $newNode );
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
						$this->debugOut( $baseNode, $lookaheadNode, 'new' );
						if ( DOMUtils::isContentNode( $lookaheadNode ) &&
							$this->treeEquals( $baseNode, $lookaheadNode, true )
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
						$lookaheadNode = self::nextNonTemplateSibling( $lookaheadNode );
					}
				}

				// look-ahead in *base* DOM to detect deletions
				if ( !$foundDiff && DOMUtils::isContentNode( $newNode ) ) {
					$isBlockNode = WTUtils::isBlockNodeWithVisibleWT( $baseNode );
					$this->debug( '--lookahead in old dom--' );
					$lookaheadNode = $baseNode->nextSibling;
					while ( $lookaheadNode ) {
						$this->debugOut( $lookaheadNode, $newNode, 'old' );
						if ( DOMUtils::isContentNode( $lookaheadNode ) &&
							$this->treeEquals( $lookaheadNode, $newNode, true )
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
						$lookaheadNode = self::nextNonTemplateSibling( $lookaheadNode );
					}
				}

				if ( !$foundDiff ) {
					if ( !( $savedNewNode instanceof Element ) ) {
						$this->debug( '--found diff: modified text/comment--' );
						$this->markNode( $savedNewNode, 'deleted', WTUtils::isBlockNodeWithVisibleWT( $baseNode ) );
					} elseif ( $baseNode instanceof Element &&
						DOMCompat::nodeName( $savedNewNode ) === DOMCompat::nodeName( $baseNode ) &&
						( DOMDataUtils::getDataParsoid( $savedNewNode )->stx ?? null ) ===
						( DOMDataUtils::getDataParsoid( $baseNode )->stx ?? null )
					) {
						// Identical wrapper-type, but modified.
						// Mark modified-wrapper, and recurse.
						$this->debug( '--found diff: modified-wrapper--' );
						$this->markNode( $savedNewNode, 'modified-wrapper' );
						$this->subtreeDiffers( $baseNode, $savedNewNode );
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
			} elseif ( $this->subtreeDiffers( $baseNode, $newNode ) ) {
				$foundDiffOverall = true;
			}

			// And move on to the next pair (skipping over template HTML)
			if ( $baseNode && $newNode ) {
				$baseNode = self::nextNonTemplateSibling( $baseNode );
				if ( !$dontAdvanceNewNode ) {
					$newNode = self::nextNonTemplateSibling( $newNode );
				}
			}
		}

		// mark extra new nodes as inserted
		while ( $newNode ) {
			$this->debug( '--found trailing new node: inserted--' );
			$this->markNode( $newNode, 'inserted' );
			$foundDiffOverall = true;
			$newNode = self::nextNonTemplateSibling( $newNode );
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
				DOMUtils::addTypeOf( $meta, 'mw:DiffMarker/deleted' );
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

	/**
	 * @param Node $baseNode
	 * @param Node $newNode
	 * @return bool
	 */
	private function subtreeDiffers( Node $baseNode, Node $newNode ): bool {
		$baseEncapsulated = WTUtils::isEncapsulationWrapper( $baseNode );
		$newEncapsulated = WTUtils::isEncapsulationWrapper( $newNode );

		if ( !$baseEncapsulated && !$newEncapsulated ) {
			$this->debug( '--shallow equal: recursing--' );
			// Recursively diff subtrees if not template-like content
			$subtreeDiffers = $this->doDOMDiff( $baseNode, $newNode );
		} elseif ( $baseEncapsulated && $newEncapsulated ) {
			// For encapsulated content, we don't know about the subtree.
			// If it conforms to the dataMWEquals conventions (body.id, body.html, etc)
			// then changes to the content will show up as modified-wrapper.
			$subtreeDiffers = false;
		} else {
			// True?  Should we recurse into $newNode and mark it all as diff
			// so that modifications aren't lost?
			$subtreeDiffers = true;
		}

		if ( $subtreeDiffers ) {
			$this->debug( '--found diff: subtree-changed--' );
			$this->markNode( $newNode, 'subtree-changed' );
		}
		return $subtreeDiffers;
	}

	/**
	 * @param Node $node
	 * @param string $mark
	 * @param bool $blockNodeDeleted
	 */
	private function markNode( Node $node, string $mark, bool $blockNodeDeleted = false ): void {
		$meta = null;
		if ( $mark === 'deleted' ) {
			// insert a meta tag marking the place where content used to be
			$meta = DiffUtils::prependTypedMeta( $node, 'mw:DiffMarker/' . $mark );
		} else {
			if ( $node instanceof Element ) {
				DiffUtils::setDiffMark( $node, $this->env, $mark );
			} elseif ( $node instanceof Text || $node instanceof Comment ) {
				if ( $mark !== 'inserted' ) {
					$this->env->log( 'error/domdiff',
						'BUG! CHANGE-marker for ' . $node->nodeType . ' node is: ' . $mark
					);
				}
				$meta = DiffUtils::prependTypedMeta( $node, 'mw:DiffMarker/' . $mark );
			} elseif ( $node->nodeType !== XML_DOCUMENT_NODE &&
				$node->nodeType !== XML_DOCUMENT_TYPE_NODE
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

		// Clear out speculatively computed DSR values for data-mw-selser-wrapper nodes
		// since they may be incorrect. This eliminates any inadvertent use of
		// these incorrect values.
		if ( $node instanceof Element && $node->hasAttribute( 'data-mw-selser-wrapper' ) ) {
			DOMDataUtils::getDataParsoid( $node )->dsr = null;
		}
	}

	/**
	 * @param Node $nodeA
	 * @param Node $nodeB
	 * @param string $laPrefix
	 */
	private function debugOut( Node $nodeA, Node $nodeB, string $laPrefix = '' ): void {
		$this->env->log(
			'trace/domdiff',
			'--> A' . $laPrefix . ':' .
				( $nodeA instanceof Element
					? DOMCompat::getOuterHTML( $nodeA )
					: PHPUtils::jsonEncode( $nodeA->nodeValue ) )
		);

		$this->env->log(
			'trace/domdiff',
			'--> B' . $laPrefix . ':' .
				( $nodeB instanceof Element
					? DOMCompat::getOuterHTML( $nodeB )
					: PHPUtils::jsonEncode( $nodeB->nodeValue ) )
		);
	}
}
