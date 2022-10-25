<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\PP\Processors;

use Wikimedia\Assert\Assert;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\DOM\Comment;
use Wikimedia\Parsoid\DOM\Document;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\DOM\Text;
use Wikimedia\Parsoid\NodeData\DataParsoid;
use Wikimedia\Parsoid\NodeData\TempData;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\WTUtils;
use Wikimedia\Parsoid\Wt2Html\Wt2HtmlDOMProcessor;

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
class MarkFosteredContent implements Wt2HtmlDOMProcessor {
	/**
	 * Create a new DOM node with attributes.
	 *
	 * @param Document $document
	 * @param string $type
	 * @param array $attrs
	 * @return Element
	 */
	private static function createNodeWithAttributes(
		Document $document, string $type, array $attrs
	): Element {
		$node = $document->createElement( $type );
		DOMUtils::addAttributes( $node, $attrs );
		return $node;
	}

	/**
	 * Cleans up transclusion shadows, keeping track of fostered transclusions
	 *
	 * @param Node $node
	 * @return bool
	 */
	private static function removeTransclusionShadows( Node $node ): bool {
		$sibling = null;
		$fosteredTransclusions = false;
		if ( $node instanceof Element ) {
			if ( DOMUtils::isMarkerMeta( $node, 'mw:TransclusionShadow' ) ) {
				$node->parentNode->removeChild( $node );
				return true;
			} elseif ( DOMDataUtils::getDataParsoid( $node )->getTempFlag( TempData::IN_TRANSCLUSION ) ) {
				$fosteredTransclusions = true;
			}
			$node = $node->firstChild;
			while ( $node ) {
				$sibling = $node->nextSibling;
				if ( self::removeTransclusionShadows( $node ) ) {
					$fosteredTransclusions = true;
				}
				$node = $sibling;
			}
		}
		return $fosteredTransclusions;
	}

	/**
	 * Inserts metas around the fosterbox and table
	 *
	 * @param Env $env
	 * @param Node $fosterBox
	 * @param Element $table
	 */
	private static function insertTransclusionMetas(
		Env $env, Node $fosterBox, Element $table
	): void {
		$aboutId = $env->newAboutId();

		// Ensure we have depth entries for 'aboutId'.
		$docDataBag = DOMDataUtils::getBag( $table->ownerDocument );
		$docDataBag->transclusionMetaTagDepthMap[$aboutId]['start'] =
			$docDataBag->transclusionMetaTagDepthMap[$aboutId]['end'] =
			DOMUtils::nodeDepth( $table );

		// You might be asking yourself, why is $table->dataParsoid->tsr->end always
		// present? The earlier implementation searched the table's siblings for
		// their tsr->start. However, encapsulation doesn't happen when the foster box,
		// and thus the table, are in the transclusion.
		$s = self::createNodeWithAttributes( $fosterBox->ownerDocument, 'meta', [
				'about' => $aboutId,
				'id' => substr( $aboutId, 1 ),
				'typeof' => 'mw:Transclusion',
			]
		);
		$dp = new DataParsoid;
		$dp->tsr = clone DOMDataUtils::getDataParsoid( $table )->tsr;
		$dp->setTempFlag( TempData::FROM_FOSTER );
		DOMDataUtils::setDataParsoid( $s, $dp );
		$fosterBox->parentNode->insertBefore( $s, $fosterBox );

		$e = self::createNodeWithAttributes( $table->ownerDocument, 'meta', [
				'about' => $aboutId,
				'typeof' => 'mw:Transclusion/End',
			]
		);

		$sibling = $table->nextSibling;
		$beforeText = null;

		// Skip past the table end, mw:shadow and any transclusions that
		// start inside the table. There may be newlines and comments in
		// between so keep track of that, and backtrack when necessary.
		while ( $sibling ) {
			if ( !WTUtils::isTplStartMarkerMeta( $sibling ) &&
				( WTUtils::hasParsoidAboutId( $sibling ) ||
					DOMUtils::isMarkerMeta( $sibling, 'mw:TransclusionShadow' )
				)
			) {
				$sibling = $sibling->nextSibling;
				$beforeText = null;
			} elseif ( $sibling instanceof Comment || $sibling instanceof Text ) {
				if ( !$beforeText ) {
					$beforeText = $sibling;
				}
				$sibling = $sibling->nextSibling;
			} else {
				break;
			}
		}

		$table->parentNode->insertBefore( $e, $beforeText ?: $sibling );
	}

	/**
	 * @param Document $doc
	 * @param bool $inPTag
	 * @return Element
	 */
	private static function getFosterContentHolder( Document $doc, bool $inPTag ): Element {
		$fosterContentHolder = $doc->createElement( $inPTag ? 'span' : 'p' );
		$dp = new DataParsoid;
		$dp->fostered = true;
		// Set autoInsertedStart for bug-compatibility with the old ProcessTreeBuilderFixups code
		$dp->autoInsertedStart = true;

		DOMDataUtils::setDataParsoid( $fosterContentHolder, $dp );
		return $fosterContentHolder;
	}

	/**
	 * Searches for FosterBoxes and does two things when it hits one:
	 * - Marks all nextSiblings as fostered until the accompanying table.
	 * - Wraps the whole thing (table + fosterbox) with transclusion metas if
	 *   there is any fostered transclusion content.
	 *
	 * @param Node $node
	 * @param Env $env
	 */
	private static function processRecursively( Node $node, Env $env ): void {
		$c = $node->firstChild;

		while ( $c ) {
			$sibling = $c->nextSibling;
			$fosteredTransclusions = false;

			if ( DOMUtils::hasNameAndTypeOf( $c, 'table', 'mw:FosterBox' ) ) {
				$inPTag = DOMUtils::hasNameOrHasAncestorOfName( $c->parentNode, 'p' );
				$fosterContentHolder = self::getFosterContentHolder( $c->ownerDocument, $inPTag );

				// mark as fostered until we hit the table
				while ( $sibling &&
					( !( $sibling instanceof Element ) || DOMCompat::nodeName( $sibling ) !== 'table' )
				) {
					$next = $sibling->nextSibling;
					if ( $sibling instanceof Element ) {
						// TODO: Note the similarity here with the p-wrapping pass.
						// This can likely be combined in some more maintainable way.
						if (
							DOMUtils::isRemexBlockNode( $sibling ) ||
							WTUtils::emitsSolTransparentSingleLineWT( $sibling )
						) {
							// Block nodes don't need to be wrapped in a p-tag either.
							// Links, includeonly directives, and other rendering-transparent
							// nodes dont need wrappers. sol-transparent wikitext generate
							// rendering-transparent nodes and we use that helper as a proxy here.
							DOMDataUtils::getDataParsoid( $sibling )->fostered = true;

							// If the foster content holder is not empty,
							// close it and get a new content holder.
							if ( $fosterContentHolder->hasChildNodes() ) {
								$sibling->parentNode->insertBefore( $fosterContentHolder, $sibling );
								$fosterContentHolder = self::getFosterContentHolder( $sibling->ownerDocument, $inPTag );
							}
						} else {
							$fosterContentHolder->appendChild( $sibling );
						}

						if ( self::removeTransclusionShadows( $sibling ) ) {
							$fosteredTransclusions = true;
						}
					} else {
						$fosterContentHolder->appendChild( $sibling );
					}
					$sibling = $next;
				}

				$table = $sibling;

				// we should be able to reach the table from the fosterbox
				Assert::invariant(
					$table instanceof Element && DOMCompat::nodeName( $table ) === 'table',
					"Table isn't a sibling. Something's amiss!"
				);

				if ( $fosterContentHolder->hasChildNodes() ) {
					$table->parentNode->insertBefore( $fosterContentHolder, $table );
				}

				// we have fostered transclusions
				// wrap the whole thing in a transclusion
				if ( $fosteredTransclusions ) {
					self::insertTransclusionMetas( $env, $c, $table );
				}

				// remove the foster box
				$c->parentNode->removeChild( $c );

			} elseif ( DOMUtils::isMarkerMeta( $c, 'mw:TransclusionShadow' ) ) {
				$c->parentNode->removeChild( $c );
			} elseif ( $c instanceof Element ) {
				if ( $c->hasChildNodes() ) {
					self::processRecursively( $c, $env );
				}
			}

			$c = $sibling;
		}
	}

	/**
	 * @inheritDoc
	 */
	public function run(
		Env $env, Node $root, array $options = [], bool $atTopLevel = false
	): void {
		self::processRecursively( $root, $env );
	}
}
