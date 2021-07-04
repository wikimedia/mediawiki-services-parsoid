<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\PP\Processors;

use stdClass;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Utils\Utils;
use Wikimedia\Parsoid\Utils\WTUtils;
use Wikimedia\Parsoid\Wt2Html\Frame;
use Wikimedia\Parsoid\Wt2Html\Wt2HtmlDOMProcessor;

class ProcessTreeBuilderFixups implements Wt2HtmlDOMProcessor {
	/**
	 * Replace a meta node with an empty text node, which will be deleted by
	 * the normalize pass. This is faster than just deleting the node if there
	 * are many nodes in the sibling array, since node deletion is sometimes
	 * done with {@link Array#splice} which is O(N).
	 * PORT-FIXME: This comment was true for domino in JS.
	 * PORT-FIXME: We should confirm if this is also true for PHP DOM.
	 *
	 * @param Node $node
	 */
	private static function deleteShadowMeta( Node $node ): void {
		$node->parentNode->replaceChild(
			$node->ownerDocument->createTextNode( '' ),
			$node
		);
	}

	/**
	 * @param Frame $frame
	 * @param Node $node
	 * @param stdClass $dp
	 * @param string $name
	 * @param stdClass $opts
	 */
	private static function addPlaceholderMeta(
		Frame $frame, Node $node, stdClass $dp, string $name, stdClass $opts
	): void {
		// If node is in a position where the placeholder
		// node will get fostered out, dont bother adding one
		// since the browser and other compliant clients will
		// move the placeholder out of the table.
		if ( DOMUtils::isFosterablePosition( $node ) ) {
			return;
		}

		$src = $dp->src ?? null;

		if ( !$src ) {
			if ( !empty( $dp->tsr ) ) {
				$src = $dp->tsr->substr( $frame->getSrcText() );
			} elseif ( !empty( $opts->tsr ) ) {
				$src = $opts->tsr->substr( $frame->getSrcText() );
			} elseif ( WTUtils::hasLiteralHTMLMarker( $dp ) ) {
				if ( !empty( $opts->start ) ) {
					$src = '<' . $name . '>';
				} elseif ( !empty( $opts->end ) ) {
					$src = '</' . $name . '>';
				}
			}
		}

		if ( $src ) {
			$placeHolder = $node->ownerDocument->createElement( 'meta' );
			DOMUtils::addTypeOf( $placeHolder, 'mw:Placeholder/StrippedTag' );
			DOMDataUtils::setDataParsoid( $placeHolder, (object)[
					'src' => $src,
					'name' => $name,
					'tmp' => new stdClass,
				]
			);

			// Insert the placeHolder
			$node->parentNode->insertBefore( $placeHolder, $node );
		}
	}

	/**
	 * Search forward for a shadow meta, skipping over other end metas
	 *
	 * @param Node $node
	 * @param string $type
	 * @param string $name
	 * @return Element|null
	 */
	private static function findMetaShadowNode(
		Node $node, string $type, string $name
	): ?Element {
		$isHTML = WTUtils::isLiteralHTMLNode( $node );
		while ( $node ) {
			$sibling = $node->nextSibling;
			if ( !$sibling || !DOMUtils::isMarkerMeta( $sibling, $type ) ) {
				return null;
			}
			'@phan-var Element $sibling';  /** @var Element $sibling */
			if ( $sibling->getAttribute( 'data-etag' ) === $name &&
				// If the node was literal html, the end tag should be as well.
				// However, the converse isn't true. A node for an
				// autoInsertedStartTag wouldn't have those markers yet.
				// See "Table with missing opening <tr> tag" test as an example.
				( !$isHTML || $isHTML === WTUtils::isLiteralHTMLNode( $sibling ) )
			) {
				return $sibling;
			}

			$node = $sibling;
		}

		return null;
	}

	/**
	 * This pass:
	 * 1. Finds start-tag marker metas that dont have a corresponding start tag
	 * and adds placeholder metas for the purposes of round-tripping.
	 * 2. Deletes any useless end-tag marker metas
	 *
	 * @param Frame $frame
	 * @param Node $node
	 */
	private static function findDeletedStartTags( Frame $frame, Node $node ): void {
		// handle unmatched mw:StartTag meta tags
		$c = $node->firstChild;
		while ( $c !== null ) {
			$sibling = $c->nextSibling;
			if ( $c instanceof Element ) {
				$dp = DOMDataUtils::getDataParsoid( $c );
				if ( $c->nodeName === 'meta' ) {
					if ( DOMUtils::hasTypeOf( $c, 'mw:StartTag' ) ) {
						$dataStag = $c->getAttribute( 'data-stag' );
						$data = explode( ':', $dataStag );
						$expectedName = $data[0];
						$prevSibling = $c->previousSibling;
						if ( ( $prevSibling && $prevSibling->nodeName !== $expectedName ) ||
							( !$prevSibling && $c->parentNode->nodeName !== $expectedName )
						) {
							if ( $c && ( $dp->stx ?? null ) !== 'html' &&
								( $expectedName === 'td' || $expectedName === 'tr' || $expectedName === 'th' )
							) {
								// A stripped wikitext-syntax td tag outside
								// of a table.  Re-insert the original page
								// source.

								// XXX: Use actual page source if this comes
								// from the top-level page. Can we easily
								// determine whether we are in a transclusion
								// at this point?
								//
								// Also, do the paragraph wrapping on the DOM.
								$origTxt = null;
								if ( !empty( $dp->tsr ) &&
									$dp->tsr->start !== null && $dp->tsr->end !== null
								) {
									$origTxt = $dp->tsr->substr( $frame->getSrcText() );
									$origTxtNode = $c->ownerDocument->createTextNode( $origTxt );
									$c->parentNode->insertBefore( $origTxtNode, $c );
								} else {
									switch ( $expectedName ) {
										case 'td':
											$origTxt = '|';
											break;
										case 'tr':
											$origTxt = '|-';
											break;
										case 'th':
											$origTxt = '!';
											break;
										default:
											$origTxt = '';
											break;
									}
									$c->parentNode->insertBefore(
										$c->ownerDocument->createTextNode( $origTxt ),
										$c
									);
								}
							} else {
								self::addPlaceholderMeta(
									$frame,
									$c,
									$dp,
									$expectedName,
									(object)[ 'start' => true, 'tsr' => $dp->tsr ?? null ]
								);
							}
						}
						self::deleteShadowMeta( $c );
					} elseif ( DOMUtils::hasTypeOf( $c, 'mw:EndTag' ) && empty( $dp->tsr ) ) {
						// If there is no tsr, this meta is useless for DSR
						// calculations. Remove the meta to avoid breaking
						// other brittle DOM passes working on the DOM.
						self::deleteShadowMeta( $c );

						// TODO: preserve stripped wikitext end tags similar
						// to start tags!
					}
				} else {
					self::findDeletedStartTags( $frame, $c );
				}
			}
			$c = $sibling;
		}
	}

	/**
	 * This pass tries to match nodes with their start and end tag marker metas
	 * and adds autoInsertedEnd/Start flags if it detects the tags to be inserted by
	 * the HTML tree builder
	 *
	 * @param Frame $frame
	 * @param Node $node
	 */
	private static function findAutoInsertedTags( Frame $frame, Node $node ): void {
		$c = $node->firstChild;

		while ( $c !== null ) {
			// Skip over enscapsulated content
			if ( WTUtils::isEncapsulationWrapper( $c ) ) {
				$c = WTUtils::skipOverEncapsulatedContent( $c );
				continue;
			}

			if ( $c instanceof Element ) {
				// Process subtree first
				self::findAutoInsertedTags( $frame, $c );

				$dp = DOMDataUtils::getDataParsoid( $c );
				$cNodeName = $c->nodeName;

				// Dont bother detecting auto-inserted start/end if:
				// -> c is a void element
				// -> c is not self-closed
				// -> c is not tbody unless it is a literal html tag
				// tbody-tags dont exist in wikitext and are always
				// closed properly.  How about figure, caption, ... ?
				// Is this last check useless optimization?????
				if ( !Utils::isVoidElement( $cNodeName ) &&
					empty( $dp->selfClose ) &&
					( $cNodeName !== 'tbody' || WTUtils::hasLiteralHTMLMarker( $dp ) )
				) {
					// Detect auto-inserted end-tags
					$metaNode = self::findMetaShadowNode( $c, 'mw:EndTag', $cNodeName );
					if ( !$metaNode ) {
						// 'c' is a html node that has tsr, but no end-tag marker tag
						// => its closing tag was auto-generated by treebuilder.
						$dp->autoInsertedEnd = true;
					}

					if ( !empty( $dp->tmp->tagId ) ) {
						// Detect auto-inserted start-tags
						$fc = $c->firstChild;
						while ( $fc ) {
							if ( !$fc instanceof Element ) {
								break;
							}
							$fcDP = DOMDataUtils::getDataParsoid( $fc );
							if ( !empty( $fcDP->autoInsertedStart ) ) {
								$fc = $fc->firstChild;
							} else {
								break;
							}
						}

						$expectedName = $cNodeName . ':' . $dp->tmp->tagId;
						if ( $fc instanceof Element && DOMUtils::isMarkerMeta( $fc, 'mw:StartTag' ) &&
							substr(
								$fc->getAttribute( 'data-stag' ),
								0,
								strlen( $expectedName )
							) === $expectedName
						) {
							// Strip start-tag marker metas that has its matching node
							self::deleteShadowMeta( $fc );
						} else {
							$dp->autoInsertedStart = true;
						}
					} else {
						// If the tag-id is missing, this is clearly a sign that the
						// start tag was inserted by the builder
						$dp->autoInsertedStart = true;
					}
				} elseif ( $cNodeName === 'meta' ) {
					if ( DOMUtils::hasTypeOf( $c, 'mw:EndTag' ) ) {
						// Got an mw:EndTag meta element, see if the previous sibling
						// is the corresponding element.
						$sibling = $c->previousSibling;
						$expectedName = $c->getAttribute( 'data-etag' );
						if ( !$sibling || $sibling->nodeName !== $expectedName ) {
							// Not found, the tag was stripped. Insert an
							// mw:Placeholder for round-tripping
							self::addPlaceholderMeta( $frame, $c, $dp, $expectedName,
								PHPUtils::arrayToObject( [ 'end' => true ] ) );
						} elseif ( !empty( $dp->stx ) ) {
							DOMUtils::assertElt( $sibling );
							// Transfer stx flag
							$siblingDP = DOMDataUtils::getDataParsoid( $sibling );
							$siblingDP->stx = $dp->stx;
						}
					}
				}
			}

			$c = $c->nextSibling;
		}
	}

	/**
	 * Done after `findDeletedStartTags` to give it a chance to cleanup any
	 * leftover meta markers that may trip up the check for whether this element
	 * is indeed empty.
	 *
	 * @param Frame $frame
	 * @param Node $node
	 */
	private static function removeAutoInsertedEmptyTags( Frame $frame, Node $node ) {
		$c = $node->firstChild;
		while ( $c !== null ) {
			// FIXME: Encapsulation only happens after this phase, so you'd think
			// we wouldn't encounter any, but the html pre tag inserts extension
			// content directly, rather than passing it through as a fragment for
			// later unpacking.  Same as above.
			if ( WTUtils::isEncapsulationWrapper( $c ) ) {
				$c = WTUtils::skipOverEncapsulatedContent( $c );
				continue;
			}

			if ( $c instanceof Element ) {
				self::removeAutoInsertedEmptyTags( $frame, $c );
				$dp = DOMDataUtils::getDataParsoid( $c );

				// We do this down here for all elements since the quote transformer
				// also marks up elements as auto-inserted and we don't want to be
				// constrained by any conditions.  Further, this pass should happen
				// before paragraph wrapping on the dom, since we don't want this
				// stripping to result in empty paragraphs.

				// Delete empty auto-inserted elements
				if ( !empty( $dp->autoInsertedStart ) && !empty( $dp->autoInsertedEnd ) &&
					( !$c->hasChildNodes() ||
						( DOMUtils::hasNChildren( $c, 1 ) &&
							!DOMUtils::isElt( $c->firstChild ) &&
							preg_match( '/^\s*$/D', $c->textContent )
						)
					)
				) {
					$next = $c->nextSibling;
					if ( $c->firstChild ) {
						// migrate the ws out
						$c->parentNode->insertBefore( $c->firstChild, $c );
					}
					$c->parentNode->removeChild( $c );
					$c = $next;
					continue;
				}
			}

			$c = $c->nextSibling;
		}
	}

	/**
	 * @inheritDoc
	 */
	public function run(
		Env $env, Node $root, array $options = [], bool $atTopLevel = false
	): void {
		$frame = $options['frame'];
		self::findAutoInsertedTags( $frame, $root );
		self::findDeletedStartTags( $frame, $root );
		self::removeAutoInsertedEmptyTags( $frame, $root );
	}
}
