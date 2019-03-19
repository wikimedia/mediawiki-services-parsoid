<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * Non-IEW (inter-element-whitespace) can only be found in <td> <th> and
 * <caption> tags in a table.  If found elsewhere within a table, such
 * content will be moved out of the table and be "adopted" by the table's
 * sibling ("foster parent"). The content that gets adopted is "fostered
 * content".
 *
 * http://www.w3.org/TR/html5/syntax.html#foster-parent
 * @module
 */

namespace Parsoid;

use Parsoid\DOMDataUtils as DOMDataUtils;
use Parsoid\DOMUtils as DOMUtils;
use Parsoid\Util as Util;
use Parsoid\WTUtils as WTUtils;

class MarkFosteredContent {
	/**
	 * Create a new DOM node with attributes.
	 */
	public function createNodeWithAttributes( $document, $type, $attrs ) {
		$node = $document->createElement( $type );
		DOMDataUtils::addAttributes( $node, $attrs );
		return $node;
	}

	// cleans up transclusion shadows, keeping track of fostered transclusions
	public function removeTransclusionShadows( $node ) {
		$sibling = null;
		$fosteredTransclusions = false;
		if ( DOMUtils::isElt( $node ) ) {
			if ( DOMUtils::isMarkerMeta( $node, 'mw:TransclusionShadow' ) ) {
				$node->parentNode->removeChild( $node );
				return true;
			} elseif ( DOMDataUtils::getDataParsoid( $node )->tmp->inTransclusion ) {
				$fosteredTransclusions = true;
			}
			$node = $node->firstChild;
			while ( $node ) {
				$sibling = $node->nextSibling;
				if ( $this->removeTransclusionShadows( $node ) ) {
					$fosteredTransclusions = true;
				}
				$node = $sibling;
			}
		}
		return $fosteredTransclusions;
	}

	// inserts metas around the fosterbox and table
	public function insertTransclusionMetas( $env, $fosterBox, $table ) {
		$aboutId = $env->newAboutId();

		// You might be asking yourself, why is table.data.parsoid.tsr[1] always
		// present? The earlier implementation searched the table's siblings for
		// their tsr[0]. However, encapsulation doesn't happen when the foster box,
		// and thus the table, are in the transclusion.
		$s = $this->createNodeWithAttributes( $fosterBox->ownerDocument, 'meta', [
				'about' => $aboutId,
				'id' => substr( $aboutId, 1 ),
				'typeof' => 'mw:Transclusion'
			]
		);
		DOMDataUtils::setDataParsoid( $s, [
				'tsr' => Util::clone( DOMDataUtils::getDataParsoid( $table )->tsr ),
				'tmp' => [ 'fromFoster' => true ]
			]
		);
		$fosterBox->parentNode->insertBefore( $s, $fosterBox );

		$e = $this->createNodeWithAttributes( $table->ownerDocument, 'meta', [
				'about' => $aboutId,
				'typeof' => 'mw:Transclusion/End'
			]
		);

		$sibling = $table->nextSibling;
		$beforeText = null;

		// Skip past the table end, mw:shadow and any transclusions that
		// start inside the table. There may be newlines and comments in
		// between so keep track of that, and backtrack when necessary.
		while ( $sibling ) {
			if ( !WTUtils::isTplStartMarkerMeta( $sibling )
&& WTUtils::hasParsoidAboutId( $sibling )
|| DOMUtils::isMarkerMeta( $sibling, 'mw:EndTag' )
|| DOMUtils::isMarkerMeta( $sibling, 'mw:TransclusionShadow' )
			) {
				$sibling = $sibling->nextSibling;
				$beforeText = null;
			} elseif ( DOMUtils::isComment( $sibling ) || DOMUtils::isText( $sibling ) ) {
				if ( !$beforeText ) {
					$beforeText = $sibling;
				}
				$sibling = $sibling->nextSibling;
			} else {
				break;
			}
		}

		$table->parentNode->insertBefore( $e, $beforeText || $sibling );
	}

	public function getFosterContentHolder( $doc, $inPTag ) {
		$fosterContentHolder = $doc->createElement( ( $inPTag ) ? 'span' : 'p' );
		DOMDataUtils::setDataParsoid( $fosterContentHolder, [ 'fostered' => true, 'tmp' => [] ] );
		return $fosterContentHolder;
	}

	/**
	 * Searches for FosterBoxes and does two things when it hits one:
	 * - Marks all nextSiblings as fostered until the accompanying table.
	 * - Wraps the whole thing (table + fosterbox) with transclusion metas if
	 *   there is any fostered transclusion content.
	 * @param {Node} node
	 * @param {MWParserEnvironment} env
	 */
	public function markFosteredContent( $node, $env ) {
		$sibling = null;
$next = null;
$fosteredTransclusions = null;
		$c = $node->firstChild;

		while ( $c ) {
			$sibling = $c->nextSibling;
			$fosteredTransclusions = false;

			if ( DOMUtils::isNodeOfType( $c, 'TABLE', 'mw:FosterBox' ) ) {
				$inPTag = DOMUtils::hasAncestorOfName( $c->parentNode, 'p' );
				$fosterContentHolder = $this->getFosterContentHolder( $c->ownerDocument, $inPTag );

				// mark as fostered until we hit the table
				while ( $sibling && ( !DOMUtils::isElt( $sibling ) || $sibling->nodeName !== 'TABLE' ) ) {
					$next = $sibling->nextSibling;
					if ( DOMUtils::isElt( $sibling ) ) {
						// TODO: Note the similarity here with the p-wrapping pass.
						// This can likely be combined in some more maintainable way.
						if ( DOMUtils::isBlockNode( $sibling ) || WTUtils::emitsSolTransparentSingleLineWT( $sibling ) ) {
							// Block nodes don't need to be wrapped in a p-tag either.
							// Links, includeonly directives, and other rendering-transparent
							// nodes dont need wrappers. sol-transparent wikitext generate
							// rendering-transparent nodes and we use that helper as a proxy here.
							DOMDataUtils::getDataParsoid( $sibling )->fostered = true;

							// If the foster content holder is not empty,
							// close it and get a new content holder.
							if ( $fosterContentHolder->hasChildNodes() ) {
								$sibling->parentNode->insertBefore( $fosterContentHolder, $sibling );
								$fosterContentHolder = $this->getFosterContentHolder( $sibling->ownerDocument, $inPTag );
							}
						} else {
							$fosterContentHolder->appendChild( $sibling );
						}

						if ( $this->removeTransclusionShadows( $sibling ) ) {
							$fosteredTransclusions = true;
						}
					} else {
						$fosterContentHolder->appendChild( $sibling );
					}
					$sibling = $next;
				}

				$table = $sibling;

				// we should be able to reach the table from the fosterbox
				Assert::invariant( $table && DOMUtils::isElt( $table ) && $table->nodeName === 'TABLE',
					"Table isn't a sibling. Something's amiss!"
				);

				if ( $fosterContentHolder->hasChildNodes() ) {
					$table->parentNode->insertBefore( $fosterContentHolder, $table );
				}

				// we have fostered transclusions
				// wrap the whole thing in a transclusion
				if ( $fosteredTransclusions ) {
					$this->insertTransclusionMetas( $env, $c, $table );
				}

				// remove the foster box
				$c->parentNode->removeChild( $c );

			} elseif ( DOMUtils::isMarkerMeta( $c, 'mw:TransclusionShadow' ) ) {
				$c->parentNode->removeChild( $c );
			} elseif ( DOMUtils::isElt( $c ) ) {
				if ( $c->hasChildNodes() ) {
					$this->markFosteredContent( $c, $env );
				}
			}

			$c = $sibling;
		}
	}

	public function run( $node, $env ) {
		$this->markFosteredContent( $node, $env );
	}
}

if ( gettype( $module ) === 'object' ) {
	$module->exports->MarkFosteredContent = $MarkFosteredContent;
}
