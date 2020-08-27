<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\PP\Handlers;

use DOMElement;
use DOMNode;
use Wikimedia\Assert\Assert;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Utils\Utils;
use Wikimedia\Parsoid\Utils\WTUtils;
use Wikimedia\Parsoid\Wt2Html\Frame;
use Wikimedia\Parsoid\Wt2Html\PegTokenizer;
use Wikimedia\Parsoid\Wt2Html\TT\Sanitizer;

/**
 * TableFixups class.
 *
 * Provides two DOMTraverser visitors that implement the two parts of
 * https://phabricator.wikimedia.org/T52603 :
 * - stripDoubleTDs
 * - reparseTemplatedAttributes
 * @class
 */
class TableFixups {
	/**
	 * @var PegTokenizer
	 */
	private $tokenizer;

	/**
	 * TableFixups constructor.
	 * @param Env $env
	 */
	public function __construct( Env $env ) {
		/**
		 * Set up some helper objects for reparseTemplatedAttributes
		 */

		/**
		 * Actually the regular tokenizer, but we'll use
		 * tokenizeTableCellAttributes only.
		 */
		$this->tokenizer = new PegTokenizer( $env );
	}

	/**
	 * DOM visitor that strips the double td for this test case:
	 * ```
	 * |{{1x|{{!}} Foo}}
	 * ```
	 *
	 * @see https://phabricator.wikimedia.org/T52603
	 * @param DOMElement $node
	 * @param Frame $frame
	 * @return bool|DOMNode
	 */
	public function stripDoubleTDs( DOMElement $node, Frame $frame ) {
		$nextNode = $node->nextSibling;
		if ( !WTUtils::isLiteralHTMLNode( $node ) &&
			$nextNode instanceof DOMElement &&
			$nextNode->nodeName === 'td' &&
			!WTUtils::isLiteralHTMLNode( $nextNode ) &&
			DOMUtils::nodeEssentiallyEmpty( $node ) && (
				// FIXME: will not be set for nested templates
				DOMUtils::hasTypeOf( $nextNode, 'mw:Transclusion' ) ||
				// Hacky work-around for nested templates
				preg_match( '/^{{.*?}}$/D', DOMDataUtils::getDataParsoid( $nextNode )->src ?? '' )
			)
		) {
			// Update the dsr. Since we are coalescing the first
			// node with the second (or, more precisely, deleting
			// the first node), we have to update the second DSR's
			// starting point and start tag width.
			$nodeDSR = DOMDataUtils::getDataParsoid( $node )->dsr ?? null;
			$nextNodeDP = DOMDataUtils::getDataParsoid( $nextNode );

			if ( $nodeDSR && !empty( $nextNodeDP->dsr ) ) {
				$nextNodeDP->dsr->start = $nodeDSR->start;
			}

			$dataMW = DOMDataUtils::getDataMw( $nextNode );
			$nodeSrc = WTUtils::getWTSource( $frame, $node );
			if ( !isset( $dataMW->parts ) ) {
				$dataMW->parts = [];
			}
			array_unshift( $dataMW->parts, $nodeSrc );

			// Delete the duplicated <td> node.
			$node->parentNode->removeChild( $node );
			// This node was deleted, so don't continue processing on it.
			return $nextNode;
		}

		return true;
	}

	/**
	 * @param DOMNode $node
	 * @return bool
	 */
	public function isSimpleTemplatedSpan( DOMNode $node ): bool {
		return $node->nodeName === 'span' &&
			DOMUtils::hasTypeOf( $node, 'mw:Transclusion' ) &&
			DOMUtils::allChildrenAreTextOrComments( $node );
	}

	/**
	 * @param Frame $frame
	 * @param DOMElement $child
	 * @param DOMElement $tdNode
	 */
	public function hoistTransclusionInfo(
		Frame $frame, DOMElement $child, DOMElement $tdNode
	): void {
		$aboutId = $child->getAttribute( 'about' );
		// Hoist all transclusion information from the child
		// to the parent tdNode.
		$tdNode->setAttribute( 'typeof', $child->getAttribute( 'typeof' ) );
		$tdNode->setAttribute( 'about', $aboutId );
		$dataMW = DOMDataUtils::getDataMw( $child );
		$parts = $dataMW->parts ?? [];
		$dp = DOMDataUtils::getDataParsoid( $tdNode );
		$childDP = DOMDataUtils::getDataParsoid( $child );
		Assert::invariant( Utils::isValidDSR( $childDP->dsr ?? null ), 'Expected valid DSR' );

		// In `handleTableCellTemplates`, we're creating a cell w/o dsr info.
		if ( !Utils::isValidDSR( $dp->dsr ?? null ) ) {
			$dp->dsr = clone $childDP->dsr;
		}

		// Get the td and content source up to the transclusion start
		if ( $dp->dsr->start < $childDP->dsr->start ) {
			$width = $childDP->dsr->start - $dp->dsr->start;
			array_unshift( $parts, PHPUtils::safeSubstr( $frame->getSrcText(), $dp->dsr->start, $width ) );
		}

		// Add wikitext for the table cell content following the
		// transclusion. This is safe as we are currently only
		// handling a single transclusion in the content, which is
		// guaranteed to have a dsr that covers the transclusion
		// itself.
		if ( $childDP->dsr->end < $dp->dsr->end ) {
			$width = $dp->dsr->end - $childDP->dsr->end;
			$parts[] = PHPUtils::safeSubstr( $frame->getSrcText(), $childDP->dsr->end, $width );
		}

		// Save the new data-mw on the tdNode
		DOMDataUtils::setDataMw( $tdNode, (object)[ 'parts' => $parts ] );
		$dp->pi = $childDP->pi ?? [];
		DOMDataUtils::setDataMw( $child, null );

		// tdNode wraps everything now.
		// Remove template encapsulation from here on.
		// This simplifies the problem of analyzing the <td>
		// for additional fixups (|| Boo || Baz) by potentially
		// invoking 'reparseTemplatedAttributes' on split cells
		// with some modifications.
		while ( $child ) {
			if ( $child->nodeName === 'span' && $child->getAttribute( 'about' ) === $aboutId ) {
				// Remove the encapsulation attributes. If there are no more attributes left,
				// the span wrapper is useless and can be removed.
				$child->removeAttribute( 'about' );
				$child->removeAttribute( 'typeof' );
				if ( DOMDataUtils::noAttrs( $child ) ) {
					$next = $child->firstChild ?: $child->nextSibling;
					DOMUtils::migrateChildren( $child, $tdNode, $child );
					$child->parentNode->removeChild( $child );
					$child = $next;
				} else {
					$child = $child->nextSibling;
				}
			} else {
				$child = $child->nextSibling;
			}
		}
	}

	/**
	 * Build the result
	 *
	 * @param array $buf
	 * @param array $nowikis
	 * @param ?DOMElement $transclusionNode
	 * @return array
	 */
	private static function buildRes(
		array $buf, array $nowikis, ?DOMElement $transclusionNode
	): array {
		return [
			'txt' => implode( '', $buf ),
			'nowikis' => $nowikis,
			'transclusionNode' => $transclusionNode,
		];
	}

	/**
	 * Collect potential attribute content.
	 *
	 * We expect this to be text nodes without a pipe character followed by one or
	 * more nowiki spans, followed by a template encapsulation with pure-text and
	 * nowiki content. Collection stops when encountering other nodes or a pipe
	 * character.
	 *
	 * @param Env $env
	 * @param DOMElement $node
	 * @param ?DOMElement $templateWrapper
	 * @return array
	 */
	public function collectAttributishContent(
		Env $env, DOMElement $node, ?DOMElement $templateWrapper
	): array {
		$buf = [];
		$nowikis = [];
		$transclusionNode = $templateWrapper ?:
			( DOMUtils::hasTypeOf( $node, 'mw:Transclusion' ) ? $node : null );
		$child = $node->firstChild;

		/*
		 * In this loop below, where we are trying to collect text content,
		 * it is safe to use child.textContent since textContent skips over
		 * comments. See this transcript of a node session:
		 *
		 *   > d.body.childNodes[0].outerHTML
		 *   '<span><!--foo-->bar</span>'
		 *   > d.body.childNodes[0].textContent
		 *   'bar'
		 *
		 * PHP parser strips comments during parsing, i.e. they don't impact
		 * how other wikitext constructs are parsed. So, in this code below,
		 * we have to skip over comments.
		 */
		while ( $child ) {
			if ( DOMUtils::isComment( $child ) ) {
				// <!--foo--> are not comments in CSS and PHP parser strips them
			} elseif ( DOMUtils::isText( $child ) ) {
				$buf[] = $child->nodeValue;
			} elseif ( $child->nodeName !== 'span' ) {
				// The idea here is that style attributes can only
				// be text/comment nodes, and nowiki-spans at best.
				// So, if we hit anything else, there is nothing more
				// to do here!
				return self::buildRes( $buf, $nowikis, $transclusionNode );
			} else {
				'@phan-var DOMElement $child';  /** @var DOMElement $child */
				if ( DOMUtils::hasTypeOf( $child, 'mw:Entity' ) ) {
					$buf[] = $child->textContent;
				} elseif ( DOMUtils::hasTypeOf( $child, 'mw:Nowiki' ) ) {
					// Nowiki span were added to protect otherwise
					// meaningful wikitext chars used in attributes.

					// Save the content.
					$nowikis[] = $child->textContent;
					// And add in a marker to splice out later.
					$buf[] = '<nowiki>';
				} elseif ( $this->isSimpleTemplatedSpan( $child ) ) {
					// And only handle a single nested transclusion for now.
					// TODO: Handle data-mw construction for multi-transclusion content
					// as well, then relax this restriction.
					//
					// If we already had a transclusion node, we return
					// without attempting to fix this up.
					if ( $transclusionNode ) {
						$env->log( 'error/dom/tdfixup', 'Unhandled TD-fixup scenario.',
							'Encountered multiple transclusion children of a <td>'
						);
						return [ 'transclusionNode' => null ];
					}

					// We encountered a transclusion wrapper
					$buf[] = $child->textContent;
					$transclusionNode = $child;
				} elseif ( $transclusionNode && DOMUtils::assertElt( $transclusionNode ) &&
					( !$child->hasAttribute( 'typeof' ) ) &&
					$child->getAttribute( 'about' ) === $transclusionNode->getAttribute( 'about' ) &&
					DOMUtils::allChildrenAreTextOrComments( $child )
				) {
					// Continue accumulating only if we hit grouped template content
					$buf[] = $child->textContent;
				} else {
					return self::buildRes( $buf, $nowikis, $transclusionNode );
				}
			}

			// Are we done accumulating?
			if ( count( $buf ) > 0 &&
				preg_match( '/(?:^|[^|])\|(?:[^|]|$)/D', PHPUtils::lastItem( $buf ) )
			) {
				return self::buildRes( $buf, $nowikis, $transclusionNode );
			}

			$child = $child->nextSibling;
		}

		return self::buildRes( $buf, $nowikis, $transclusionNode );
	}

	/**
	 * T46498, second part of T52603
	 *
	 * Handle wikitext like
	 * ```
	 * {|
	 * |{{nom|Bar}}
	 * |}
	 * ```
	 * where nom expands to `style="foo" class="bar"|Bar`. The attributes are
	 * tokenized and stripped from the table contents.
	 *
	 * This method works well for the templates documented in
	 * https://en.wikipedia.org/wiki/Template:Table_cell_templates/doc
	 *
	 * Nevertheless, there are some limitations:
	 * - We assume that attributes don't contain wiki markup (apart from <nowiki>)
	 *   and end up in text or nowiki nodes.
	 * - Only a single table cell is produced / opened by the template that
	 *   contains the attributes. This limitation could be lifted with more
	 *   aggressive re-parsing if really needed in practice.
	 * - There is only a single transclusion in the table cell content. This
	 *   limitation can be lifted with more advanced data-mw construction.
	 *
	 * @param Frame $frame
	 * @param DOMElement $node
	 * @param ?DOMElement $templateWrapper
	 */
	public function reparseTemplatedAttributes(
		Frame $frame, DOMElement $node, ?DOMElement $templateWrapper
	): void {
		$env = $frame->getEnv();
		// Collect attribute content and examine it
		$attributishContent = $this->collectAttributishContent( $env, $node, $templateWrapper );

		// Check for the pipe character in the attributish text.
		if ( !preg_match( '/^[^|]+\|([^|].*)?$/D', $attributishContent['txt'] ?? '' ) ) {
			return;
		}

		// Try to re-parse the attributish text content
		// PORT-CHECK-ME, it was refactored without testing!!!
		if ( preg_match( '/^[^|]+\|/', $attributishContent['txt'] ?? '', $matches ) ) {
			$attributishPrefix = $matches[0];
		} else {
			$attributishPrefix = '';
		}

		// Splice in nowiki content.  We added in <nowiki> markers to prevent the
		// above regexps from matching on nowiki-protected chars.
		if ( preg_match( '/<nowiki>/', $attributishPrefix ) ) {
			$attributishPrefix = preg_replace_callback(
				'/<nowiki>/',
				function ( $unused ) use ( &$attributishContent ) {
					// This is a little tricky.  We want to use the content from the
					// nowikis to reparse the string to kev/val pairs but the rule,
					// single_cell_table_args, will invariably get tripped up on
					// newlines which, to this point, were shuttled through in the
					// nowiki.  php's santizer will do this replace in attr vals so
					// it's probably a safe assumption ...
					return preg_replace( '/\s+/', ' ', array_shift( $attributishContent['nowikis'] ) );
				},
				$attributishPrefix
			);
		}

		// re-parse the attributish prefix
		$attributeTokens = $this->tokenizer->tokenizeTableCellAttributes( $attributishPrefix, false );

		// No attributes => nothing more to do!
		if ( !$attributeTokens ) {
			return;
		}

		// Note that `row_syntax_table_args` (the rule used for tokenizing above)
		// returns an array consisting of [table_attributes, spaces, pipe]
		$attrs = $attributeTokens[0];

		// Found attributes; sanitize them
		// and transfer the sanitized attributes to the td node
		Sanitizer::applySanitizedArgs( $env, $node, $attrs );

		// If the transclusion node was embedded within the td node,
		// lift up the about group to the td node.
		$transclusionNode = $attributishContent['transclusionNode'] ?? null;
		if ( $transclusionNode !== null && $node !== $transclusionNode ) {
			$this->hoistTransclusionInfo( $frame, $transclusionNode, $node );
		}

		// Drop nodes that have been consumed by the reparsed attribute content.
		$n = $node->firstChild;
		while ( $n ) {
			if ( preg_match( '/[|]/', $n->textContent ) ) {
				// Remove the consumed prefix from the text node
				$nValue = $n->nodeName === '#text' ? $n->nodeValue : $n->textContent;
				// and convert it into a simple text node
				$textNode = $node->ownerDocument->createTextNode(
					preg_replace( '/^[^|]*[|]/', '', $nValue, 1 )
				);
				$node->replaceChild( $textNode, $n );
				break;
			} else {
				$next = $n->nextSibling;
				// content was consumed by attributes, so just drop it from the cell
				$node->removeChild( $n );
				$n = $next;
			}
		}
	}

	/**
	 * @param Frame $frame
	 * @param DOMElement $cell
	 * @return bool
	 */
	private function combineWithPreviousCell( Frame $frame, DOMElement $cell ): bool {
		$prev = $cell->previousSibling;
		if ( !$prev ) {
			return false;
		}

		// Build the attribute string
		DOMUtils::assertElt( $prev );
		$dp = DOMDataUtils::getDataParsoid( $prev );
		$prevCellSrc = PHPUtils::safeSubstr( $frame->getSrcText(), $dp->dsr->start, $dp->dsr->length() );
		$cellAttrSrc = substr( $prevCellSrc, $dp->dsr->openWidth );
		$reparseSrc = $cellAttrSrc . "|"; // "|" or "!", but doesn't matter since we discard that anyway

		// Reparse the attributish prefix
		$attributeTokens = $this->tokenizer->tokenizeTableCellAttributes( $reparseSrc, false );
		Assert::invariant( is_array( $attributeTokens ), "Expected successful parse of $reparseSrc" );

		// Note that `row_syntax_table_args` (the rule used for tokenizing above)
		// returns an array consisting of [table_attributes, spaces, pipe]
		$attrs = $attributeTokens[0];

		Sanitizer::applySanitizedArgs( $frame->getEnv(), $cell, $attrs );

		// Update data-mw, DSR
		$dataMW = DOMDataUtils::getDataMw( $cell );
		array_unshift( $dataMW->parts, $prevCellSrc );
		$cellDSR = DOMDataUtils::getDataParsoid( $cell )->dsr ?? null;
		if ( $cellDSR && $cellDSR->start ) {
			$cellDSR->start -= strlen( $prevCellSrc );
		}

		$prev->parentNode->removeChild( $prev );

		return true;
	}

	private const NO_REPARSING = 0;
	private const COMBINE_WITH_PREV_CELL = 1;
	private const OTHER_REPARSE = 2;

	/**
	 * Can we combine two table cells?
	 * @param string $cell
	 * @param string $prev
	 * @return bool
	 */
	private function combinableNodes( string $cell, string $prev ): bool {
		return $cell === 'td' && ( $prev === 'td' || $prev === 'th' );
	}

	/**
	 * @param DOMElement $node
	 * @return int
	 */
	private function getReparseType( DOMElement $node ): int {
		$dp = DOMDataUtils::getDataParsoid( $node );
		$isTplWrapper = WTUtils::isFirstEncapsulationWrapperNode( $node );
		if ( $isTplWrapper &&
			!isset( $dp->tmp->failedReparse ) &&
			// If this is a (templated) cell without attributes, then it could
			// combine with the previous cell (outside the template) and reparse.
			// A cell with attributes doesn't have the right syntactic form
			// for this specific recombination to be triggered.
			// i.e. |class="foo"{{1x|{{!}}foo}}
			// vs.  |class="foo"{{1x|1={{!}}title="x"{{!}}foo}}
			// In the second example above, a recombination and reparse could still
			// alter the table cell but we'll need to add additional code and for now,
			// we are only supporting a narrow range of use cases. There are at least
			// two other known edge cases that we aren't supporting besides this one.
			// |class="foo"{{1x| foo}} and |class="foo"{{1x|&nbsp;foo}}
			// So, unless there is a simpler redesign of this table fixup code,
			// we are deliberately constraining support to the 'noAttrs' case.
			isset( $dp->tmp->noAttrs ) && !isset( $dp->stx ) &&
			$this->combinableNodes( $node->nodeName, $node->previousSibling->nodeName ?? '' )
		) {
			return self::COMBINE_WITH_PREV_CELL;
		}

		$testRE = ( $node->nodeName === 'td' ) ? '/[|]/' : '/[!|]/';
		$child = $node->firstChild;
		while ( $child ) {
			if ( DOMUtils::isText( $child ) && preg_match( $testRE, $child->textContent ) ) {
				return self::OTHER_REPARSE;
			} elseif ( $child->nodeName === 'span' ) {
				if ( WTUtils::hasParsoidAboutId( $child ) && preg_match( $testRE, $child->textContent ) ) {
					return self::OTHER_REPARSE;
				}
			}
			$child = $child->nextSibling;
		}

		return self::NO_REPARSING;
	}

	/**
	 * @param DOMElement $node
	 * @param Frame $frame
	 * @return mixed
	 */
	public function handleTableCellTemplates(
		DOMElement $node, Frame $frame
	) {
		if ( WTUtils::isLiteralHTMLNode( $node ) ) {
			return true;
		}

		$reparseType = $this->getReparseType( $node );
		if ( $reparseType === self::NO_REPARSING ) {
			return true;
		}

		if ( $reparseType === self::COMBINE_WITH_PREV_CELL ) {
			if ( $this->combineWithPreviousCell( $frame, $node ) ) {
				return true;
			} else {
				// Clear property and retry node for other reparses
				// The DOMTraverser will resume the handler on the
				// returned node.
				DOMDataUtils::getDataParsoid( $node )->tmp->failedReparse = true;
				return $node;
			}
		}

		// If the cell didn't have attrs, extract and reparse templated attrs
		$dp = DOMDataUtils::getDataParsoid( $node );
		$hasAttrs = empty( $dp->tmp->noAttrs );
		if ( !$hasAttrs ) {
			$templateWrapper = DOMUtils::hasTypeOf( $node, 'mw:Transclusion' ) ? $node : null;
			$this->reparseTemplatedAttributes( $frame, $node, $templateWrapper );
		}

		// Now, examine the <td> to see if it hides additional <td>s
		// and split it up if required.
		//
		// DOMTraverser will process the new cell and invoke
		// handleTableCellTemplates on it which ensures that
		// if any addition attribute fixup or splits are required,
		// they will get done.
		$newCell = null;
		$ownerDoc = $node->ownerDocument;
		$child = $node->firstChild;
		while ( $child ) {
			$next = $child->nextSibling;

			if ( $newCell ) {
				$newCell->appendChild( $child );
			} elseif ( DOMUtils::isText( $child ) || $this->isSimpleTemplatedSpan( $child ) ) {
				$cellName = $node->nodeName;
				$hasSpanWrapper = !DOMUtils::isText( $child );
				$match = null;

				if ( $cellName === 'td' ) {
					preg_match( '/^(.*?[^|])?\|\|([^|].*)?$/D', $child->textContent, $match );
				} else { /* cellName === 'th' */
					// Find the first match of || or !!
					preg_match( '/^(.*?[^|])?\|\|([^|].*)?$/D', $child->textContent, $match1 );
					preg_match( '/^(.*?[^!])?\!\!([^!].*)?$/D', $child->textContent, $match2 );
					if ( $match1 && $match2 ) {
						$match = strlen( $match1[1] ?? '' ) < strlen( $match2[1] ?? '' )
							? $match1
							: $match2;
					} else {
						$match = $match1 ?: $match2;
					}
				}

				if ( $match ) {
					$child->textContent = $match[1] ?? '';

					$newCell = $ownerDoc->createElement( $cellName );
					if ( $hasSpanWrapper ) {
						/**
						 * $hasSpanWrapper, above, ensures $child is a span.
						 *
						 * @var DOMElement $child
						 */
						'@phan-var DOMElement $child';
						// Fix up transclusion wrapping
						$about = $child->getAttribute( 'about' );
						$this->hoistTransclusionInfo( $frame, $child, $node );
					} else {
						// Refetch the about attribute since 'reparseTemplatedAttributes'
						// might have added one to it.
						$about = $node->getAttribute( 'about' );
					}

					// about may not be present if the cell was inside
					// wrapped template content rather than being part
					// of the outermost wrapper.
					if ( $about ) {
						$newCell->setAttribute( 'about', $about );
					}
					$newCell->appendChild( $ownerDoc->createTextNode( $match[2] ?? '' ) );
					$node->parentNode->insertBefore( $newCell, $node->nextSibling );

					// Set data-parsoid noAttrs flag
					$newCellDP = DOMDataUtils::getDataParsoid( $newCell );
					$newCellDP->tmp->noAttrs = true;
				}
			}

			$child = $next;
		}

		return true;
	}
}
