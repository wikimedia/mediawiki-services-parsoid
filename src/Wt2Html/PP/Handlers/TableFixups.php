<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\PP\Handlers;

use DOMElement;
use DOMNode;
use Wikimedia\Assert\Assert;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Core\Sanitizer;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Utils\Utils;
use Wikimedia\Parsoid\Utils\WTUtils;
use Wikimedia\Parsoid\Wt2Html\Frame;
use Wikimedia\Parsoid\Wt2Html\PegTokenizer;

/**
 * TableFixups class.
 *
 * Provides DOMTraverser visitors that fix template-induced interrupted table cell parsing
 * by recombining table cells and/or reparsing table cell content as attributes.
 * - stripDoubleTDs
 * - handleTableCellTemplates
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
	private function isSimpleTemplatedSpan( DOMNode $node ): bool {
		return $node->nodeName === 'span' &&
			DOMUtils::hasTypeOf( $node, 'mw:Transclusion' ) &&
			DOMUtils::allChildrenAreTextOrComments( $node );
	}

	/**
	 * @param array &$parts
	 * @param Frame $frame
	 * @param int $offset1
	 * @param int $offset2
	 */
	private function fillDSRGap( array &$parts, Frame $frame, int $offset1, int $offset2 ): void {
		if ( $offset1 < $offset2 ) {
			$parts[] = PHPUtils::safeSubstr( $frame->getSrcText(), $offset1,  $offset2 - $offset1 );
		}
	}

	/**
	 * Hoist transclusion information from cell content / attributes
	 * onto the cell itself.
	 *
	 * @param Frame $frame
	 * @param DOMElement[] $transclusions
	 * @param DOMElement $td
	 */
	private function hoistTransclusionInfo(
		Frame $frame, array $transclusions, DOMElement $td
	): void {
		// Initialize dsr for $td
		// In `handleTableCellTemplates`, we're creating a cell w/o dsr info.
		$tdDp = DOMDataUtils::getDataParsoid( $td );
		if ( !Utils::isValidDSR( $tdDp->dsr ?? null ) ) {
			$tplDp = DOMDataUtils::getDataParsoid( $transclusions[0] );
			Assert::invariant( Utils::isValidDSR( $tplDp->dsr ?? null ), 'Expected valid DSR' );
			$tdDp->dsr = clone $tplDp->dsr;
		}

		// Build up $parts, $pi to set up the combined transclusion info on $td.
		// Note that content for all but the last template has been swallowed into
		// the attributes of $td.
		$parts = [];
		$pi = [];
		$lastTpl = null;
		$prevDp = null;

		$index = 0;
		foreach ( $transclusions as $i => $tpl ) {
			$tplDp = DOMDataUtils::getDataParsoid( $tpl );
			Assert::invariant( Utils::isValidDSR( $tplDp->dsr ?? null ), 'Expected valid DSR' );

			// Plug DSR gaps between transclusions
			if ( !$prevDp ) {
				$this->fillDSRGap( $parts, $frame, $tdDp->dsr->start, $tplDp->dsr->start );
			} else {
				$this->fillDSRGap( $parts, $frame, $prevDp->dsr->end, $tplDp->dsr->start );
			}

			// Assimilate $tpl's data-mw and data-parsoid pi info
			$dmw = DOMDataUtils::getDataMw( $tpl );
			foreach ( $dmw->parts as $tplInfo ) {
				// Template index is relative  to other transclusions.
				// This index is used to extract whitespace information from
				// data-parsoid and that array only includes info for templates.
				// So skip over strings here.
				if ( !is_string( $tplInfo ) ) {
					$tplInfo->template->i = $index++;
				}
				$parts[] = $tplInfo;
			}
			$pi = array_merge( $pi, $tplDp->pi ?? [ [] ] );
			DOMDataUtils::setDataMw( $tpl, null );

			$lastTpl = $tpl;
			$prevDp = $tplDp;
		}

		$aboutId = $lastTpl->getAttribute( 'about' );

		// Hoist transclusion information to $td.
		$td->setAttribute( 'typeof', 'mw:Transclusion' );
		$td->setAttribute( 'about', $aboutId );

		// Add wikitext for the table cell content following $lastTpl
		$this->fillDSRGap( $parts, $frame, $prevDp->dsr->end, $tdDp->dsr->end );

		// Save the new data-mw on the td
		DOMDataUtils::setDataMw( $td, (object)[ 'parts' => $parts ] );
		$tdDp->pi = $pi;

		// td wraps everything now.
		// Remove template encapsulation from here on.
		// This simplifies the problem of analyzing the <td>
		// for additional fixups (|| Boo || Baz) by potentially
		// invoking 'reparseTemplatedAttributes' on split cells
		// with some modifications.
		$child = $lastTpl;
		while ( $child ) {
			if ( $child->nodeName === 'span' && $child->getAttribute( 'about' ) === $aboutId ) {
				// Remove the encapsulation attributes. If there are no more attributes left,
				// the span wrapper is useless and can be removed.
				$child->removeAttribute( 'about' );
				$child->removeAttribute( 'typeof' );
				if ( DOMDataUtils::noAttrs( $child ) ) {
					$next = $child->firstChild ?: $child->nextSibling;
					DOMUtils::migrateChildren( $child, $td, $child );
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
	 * Collect potential attribute content.
	 *
	 * We expect this to be text nodes without a pipe character followed by one or
	 * more nowiki spans, followed by a template encapsulation with pure-text and
	 * nowiki content. Collection stops when encountering a pipe character.
	 *
	 * @param Env $env
	 * @param DOMElement $cell known to be <td> / <th>
	 * @param ?DOMElement $templateWrapper
	 * @return array
	 */
	public function collectAttributishContent(
		Env $env, DOMElement $cell, ?DOMElement $templateWrapper
	): array {
		$buf = [];
		$nowikis = [];
		$transclusions = $templateWrapper ? [ $templateWrapper ] : [];

		// Some of this logic could be replaced by DSR-based recovery of
		// wikitext that is outside templates. But since we have to walk over
		// templated content in this fashion anyway, we might as well use the
		// same logic uniformly.

		$traverse = function ( ?DOMNode $child ) use (
			&$traverse, &$buf, &$nowikis, &$transclusions
		): bool {
			while ( $child ) {
				if ( DOMUtils::isComment( $child ) ) {
					// Legacy parser strips comments during parsing => drop them.
				} elseif ( DOMUtils::isText( $child ) ) {
					$buf[] = $child->nodeValue;
				} else {
					'@phan-var DOMElement $child';  /** @var DOMElement $child */
					if ( DOMUtils::hasTypeOf( $child, 'mw:Transclusion' ) ) {
						$transclusions[] = $child;
					}

					if ( DOMUtils::matchTypeOf( $child, "#mw:Extension/#" ) ) {
						// "|" chars in extension content don't trigger table-cell parsing
						// since they have higher precedence in tokenization. The extension
						// content will simply be dropped (but any side effects it had will
						// continue to apply. Ex: <ref> tags might leave an orphaned ref in
						// the <references> section).
						$child = WTUtils::skipOverEncapsulatedContent( $child );
						continue;
					} elseif ( DOMUtils::hasTypeOf( $child, 'mw:Entity' ) ) {
						$buf[] = $child->textContent;
					} elseif ( DOMUtils::hasTypeOf( $child, 'mw:Nowiki' ) ) {
						// Nowiki span were added to protect otherwise
						// meaningful wikitext chars used in attributes.
						// Save the content and add in a marker to splice out later.
						$nowikis[] = $child->textContent;
						$buf[] = '<nowiki-marker>';
					} elseif ( $child->getAttribute( "rel" ) === "mw:WikiLink" ||
						WTUtils::isGeneratedFigure( $child )
					) {
						// Wikilinks/images abort attribute parsing
						return true;
					} else {
						if ( $traverse( $child->firstChild ) ) {
							return true;
						}
					}
				}

				// Are we done accumulating?
				if ( count( $buf ) > 0 &&
					preg_match( '/(?:^|[^|])\|(?:[^|]|$)/D', PHPUtils::lastItem( $buf ) )
				) {
					return true;
				}

				$child = $child->nextSibling;
			}

			return false;
		};

		$traverse( $cell->firstChild );

		return [
			'txt' => implode( '', $buf ),
			'nowikis' => $nowikis,
			'transclusions' => $transclusions,
		];
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
	 * @param DOMElement $cell known to be <td> / <th>
	 * @param ?DOMElement $templateWrapper
	 */
	public function reparseTemplatedAttributes(
		Frame $frame, DOMElement $cell, ?DOMElement $templateWrapper
	): void {
		$env = $frame->getEnv();
		// Collect attribute content and examine it
		$attributishContent = $this->collectAttributishContent( $env, $cell, $templateWrapper );

		/**
		 * FIXME: These checks are insufficient.
		 * Previous rounds of table fixups might have created this cell without
		 * any templated content (the while loop in handleTableCellTemplates).
		 * Till we figure out a reliable test for this, we'll reparse attributes always.
		 *
		 * // This DOM pass is trying to bridge broken parses across
		 * // template boundaries. so, if templates aren't involved,
		 * // no reason to reparse.
		 * if ( count( $attributishContent['transclusions'] ) === 0 &&
		 * 	!WTUtils::fromEncapsulatedContent( $cell )
		 * ) {
		 * 	return;
		 * }
		 */

		$attrText = $attributishContent['txt'] ?? '';
		// Check for the pipe character in the attributish text.
		if ( !preg_match( '/^[^|]+\|([^|]|$)/D', $attrText ) ) {
			return;
		}

		// Try to re-parse the attributish text content
		if ( !preg_match( '/^[^|]+\|/', $attrText, $matches ) ) {
			return;
		}

		$attributishPrefix = $matches[0];

		// Splice in nowiki content.  We added in <nowiki> markers to prevent the
		// above regexps from matching on nowiki-protected chars.
		if ( preg_match( '/<nowiki-marker>/', $attributishPrefix ) ) {
			$attributishPrefix = preg_replace_callback(
				'/<nowiki-marker>/',
				function ( $unused ) use ( &$attributishContent ) {
					// This is a little tricky. We want to use the content from the
					// nowikis to reparse the string to key/val pairs but the rule,
					// single_cell_table_args, will invariably get tripped up on
					// newlines which, to this point, were shuttled through in the
					// nowiki. Core sanitizer will do this replacement in attr vals
					// so it's a safe normalization to do here.
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

		// Sanitize attrs and transfer them to the td node
		Sanitizer::applySanitizedArgs( $env->getSiteConfig(), $cell, $attrs );

		// If the transclusion node was embedded within the td node,
		// lift up the about group to the td node.
		$transclusions = $attributishContent['transclusions'];
		if ( $transclusions && ( $cell !== $transclusions[0] || count( $transclusions ) > 1 ) ) {
			$this->hoistTransclusionInfo( $frame, $transclusions, $cell );
		}

		// Drop content that has been consumed by the reparsed attribute content.
		// NOTE: We serialize and reparse data-object-id attributes as well which
		// ensures stashed data-* attributes continue to be usable.
		DOMCompat::setInnerHTML( $cell,
			preg_replace( '/^[^|]*\|/', '', DOMCompat::getInnerHTML( $cell ) ) );
	}

	/**
	 * @param Frame $frame
	 * @param DOMElement $cell
	 * @return bool
	 */
	private function combineWithPreviousCell( Frame $frame, DOMElement $cell ): bool {
		// UNSUPPORTED SCENARIO 1:
		// While in the general case, we should look for combinability no matter
		// whether $cell has attributes or not,  we are currently restricting
		// our support to use cases where $cell doesn't have attributes since that
		// is the common scenario and use case for this kind of markup.
		//
		//     Ex: |class="foo"{{1x|1={{!}}title="x"{{!}}foo}}
		//         should parse as <td class="foo">title="x"|foo</td>
		$cellDp = DOMDataUtils::getDataParsoid( $cell );
		if ( !isset( $cellDp->tmp->noAttrs ) ) {
			return false;
		}

		$prev = $cell->previousSibling;
		DOMUtils::assertElt( $prev );

		// UNSUPPORTED SCENARIO 2:
		// If the previous cell had attributes, the attributes/content of $cell
		// would end up as the content of the combined cell.
		//
		//     Ex: |class="foo"|bar{{1x|1={{!}}foo}}
		//         should parse as <td class="foo">bar|foo</td>
		//
		// UNSUPPORTED SCENARIO 3:
		// The template produced attributes as well as maybe a new cell.
		//     Ex: |class="foo"{{1x| foo}} and |class="foo"{{1x|&nbsp;foo}}
		// We let the more general 'reparseTemplatedAttributes' code handle
		// this scenario for now.
		$prevDp = DOMDataUtils::getDataParsoid( $prev );
		if ( !isset( $prevDp->tmp->noAttrs ) ) {
			return false;
		}

		// Build the attribute string
		$prevCellSrc = PHPUtils::safeSubstr(
			$frame->getSrcText(), $prevDp->dsr->start, $prevDp->dsr->length() );
		$cellAttrSrc = substr( $prevCellSrc, $prevDp->dsr->openWidth );
		$reparseSrc = $cellAttrSrc . "|"; // "|" or "!", but doesn't matter since we discard that anyway

		// Reparse the attributish prefix
		$attributeTokens = $this->tokenizer->tokenizeTableCellAttributes( $reparseSrc, false );
		Assert::invariant( is_array( $attributeTokens ), "Expected successful parse of $reparseSrc" );

		// Note that `row_syntax_table_args` (the rule used for tokenizing above)
		// returns an array consisting of [table_attributes, spaces, pipe]
		$attrs = $attributeTokens[0];

		Sanitizer::applySanitizedArgs( $frame->getEnv()->getSiteConfig(), $cell, $attrs );

		// Update data-mw, DSR
		$dataMW = DOMDataUtils::getDataMw( $cell );
		array_unshift( $dataMW->parts, $prevCellSrc );
		$cellDSR = $cellDp->dsr ?? null;
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
	 * @param DOMElement $cell $cell is known to be <td>/<th>
	 * @return int
	 */
	private function getReparseType( DOMElement $cell ): int {
		$isTd = $cell->nodeName === 'td';
		$dp = DOMDataUtils::getDataParsoid( $cell );
		if ( $isTd && // only | can separate attributes & content => $cell has to be <td>
			WTUtils::isFirstEncapsulationWrapperNode( $cell ) && // See long comment below
			!isset( $dp->tmp->failedReparse ) &&
			!isset( $dp->stx ) // has to be first cell of the row
		) {
			// Parsoid parses content of templates independent of top-level content.
			// But, this breaks legacy-parser-supported use-cases where template
			// content combines with top-level content to yield a table cell whose
			// source straddles the template boundary.
			//
			// In Parsoid, we handle this by looking for opportunities where
			// table cells could combine. This obviously requires $cell to be
			// a templated cell. But, we don't support combining templated cells
			// with other templated cells.  So, previous sibling cannot be templated.

			$prev = $cell->previousSibling;
			if ( $prev instanceof DOMElement &&
				!WTUtils::hasLiteralHTMLMarker( DOMDataUtils::getDataParsoid( $prev ) ) &&
				!DOMUtils::hasTypeOf( $prev, 'mw:Transclusion' ) &&
				!preg_match( '/\n/', DOMCompat::getInnerHTML( $prev ) )
			) {
				return self::COMBINE_WITH_PREV_CELL;
			}
		}

		$testRE = $isTd ? '/[|]/' : '/[!|]/';
		$child = $cell->firstChild;
		while ( $child ) {
			if ( DOMUtils::isText( $child ) && preg_match( $testRE, $child->textContent ) ) {
				return self::OTHER_REPARSE;
			}

			if ( DOMUtils::matchTypeOf( $child, "#mw:Extension/#" ) ) {
				// "|" chars in extension content don't trigger table-cell parsing
				// since they have higher precedence in tokenization
				$child = WTUtils::skipOverEncapsulatedContent( $child );
			} else {
				if ( $child instanceof DOMElement ) {
					if ( $child->getAttribute( "rel" ) === "mw:WikiLink" ||
						WTUtils::isGeneratedFigure( $child )
					) {
						// Wikilinks/images abort attribute parsing
						return self::NO_REPARSING;
					}
					if ( preg_match( $testRE, DOMCompat::getOuterHTML( $child ) ) ) {
						// A "|" char in the HTML will trigger table cell tokenization.
						// Ex: "| foobar <div> x | y </div>" will split the <div>
						// in table-cell tokenization context.
						return self::OTHER_REPARSE;
					}
				}
				$child = $child->nextSibling;
			}
		}

		return self::NO_REPARSING;
	}

	/**
	 * @param DOMElement $cell $cell is known to be <td>/<th>
	 * @param Frame $frame
	 * @return mixed
	 */
	public function handleTableCellTemplates(
		DOMElement $cell, Frame $frame
	) {
		if ( WTUtils::isLiteralHTMLNode( $cell ) ) {
			return true;
		}

		$reparseType = $this->getReparseType( $cell );
		if ( $reparseType === self::NO_REPARSING ) {
			return true;
		}

		if ( $reparseType === self::COMBINE_WITH_PREV_CELL ) {
			if ( $this->combineWithPreviousCell( $frame, $cell ) ) {
				return true;
			} else {
				// Clear property and retry $cell for other reparses
				// The DOMTraverser will resume the handler on the
				// returned $cell.
				DOMDataUtils::getDataParsoid( $cell )->tmp->failedReparse = true;
				return $cell;
			}
		}

		// If the cell didn't have attrs, extract and reparse templated attrs
		$dp = DOMDataUtils::getDataParsoid( $cell );
		if ( isset( $dp->tmp->noAttrs ) ) {
			$templateWrapper = DOMUtils::hasTypeOf( $cell, 'mw:Transclusion' ) ? $cell : null;
			$this->reparseTemplatedAttributes( $frame, $cell, $templateWrapper );
		}

		// Now, examine the <td> to see if it hides additional <td>s
		// and split it up if required.
		//
		// DOMTraverser will process the new cell and invoke
		// handleTableCellTemplates on it which ensures that
		// if any addition attribute fixup or splits are required,
		// they will get done.
		$newCell = null;
		$isTd = $cell->nodeName === 'td';
		$ownerDoc = $cell->ownerDocument;
		$child = $cell->firstChild;
		while ( $child ) {
			$next = $child->nextSibling;

			if ( $newCell ) {
				$newCell->appendChild( $child );
			} elseif ( DOMUtils::isText( $child ) || $this->isSimpleTemplatedSpan( $child ) ) {
				// FIXME: This skips over scenarios like <div>foo||bar</div>.
				$cellName = $cell->nodeName;
				$hasSpanWrapper = !DOMUtils::isText( $child );
				$match = null;

				if ( $isTd ) {
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
						 * $hasSpanWrapper above ensures $child is a span.
						 *
						 * @var DOMElement $child
						 */
						'@phan-var DOMElement $child';
						// Fix up transclusion wrapping
						$about = $child->getAttribute( 'about' );
						$this->hoistTransclusionInfo( $frame, [ $child ], $cell );
					} else {
						// Refetch the about attribute since 'reparseTemplatedAttributes'
						// might have added one to it.
						$about = $cell->getAttribute( 'about' );
					}

					// about may not be present if the cell was inside
					// wrapped template content rather than being part
					// of the outermost wrapper.
					if ( $about ) {
						$newCell->setAttribute( 'about', $about );
					}
					$newCell->appendChild( $ownerDoc->createTextNode( $match[2] ?? '' ) );
					$cell->parentNode->insertBefore( $newCell, $cell->nextSibling );

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
