<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module */

namespace Parsoid;

$DOMDataUtils = require '../../../utils/DOMDataUtils.js'::DOMDataUtils;
$DOMUtils = require '../../../utils/DOMUtils.js'::DOMUtils;
$JSUtils = require '../../../utils/jsutils.js'::JSUtils;
$Util = require '../../../utils/Util.js'::Util;
$WTUtils = require '../../../utils/WTUtils.js'::WTUtils;
$PegTokenizer = require '../../tokenizer.js'::PegTokenizer;
$Sanitizer = require '../../tt/Sanitizer.js'::Sanitizer;

/**
 * TableFixups class.
 *
 * Provides two DOMTraverser visitors that implement the two parts of
 * https://phabricator.wikimedia.org/T52603 :
 * - stripDoubleTDs
 * - reparseTemplatedAttributes.
 * @class
 */
function TableFixups( $env ) {
	global $PegTokenizer;
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
 * |{{echo|{{!}} Foo}}
 * ```
 *
 * @see https://phabricator.wikimedia.org/T52603
 */
TableFixups::prototype::stripDoubleTDs = function ( $node, $env ) use ( &$WTUtils, &$DOMUtils, &$DOMDataUtils ) {
	$nextNode = $node->nextSibling;

	if ( !WTUtils::isLiteralHTMLNode( $node )
&& $nextNode !== null
&& $nextNode->nodeName === 'TD'
&& !WTUtils::isLiteralHTMLNode( $nextNode )
&& DOMUtils::nodeEssentiallyEmpty( $node )
&&
			// FIXME: will not be set for nested templates
			DOMUtils::hasTypeOf( $nextNode, 'mw:Transclusion' )
|| // Hacky work-around for nested templates
				preg_match( '/^{{.*?}}$/', DOMDataUtils::getDataParsoid( $nextNode )->src )
	) {

		// Update the dsr. Since we are coalescing the first
		// node with the second (or, more precisely, deleting
		// the first node), we have to update the second DSR's
		// starting point and start tag width.
		$nodeDSR = DOMDataUtils::getDataParsoid( $node )->dsr;
		$nextNodeDSR = DOMDataUtils::getDataParsoid( $nextNode )->dsr;

		if ( $nodeDSR && $nextNodeDSR ) {
			$nextNodeDSR[ 0 ] = $nodeDSR[ 0 ];
		}

		$dataMW = DOMDataUtils::getDataMw( $nextNode );
		$nodeSrc = WTUtils::getWTSource( $env, $node );
		if ( !$dataMW->parts ) {
			$dataMW->parts = [];
		}
		array_unshift( $dataMW->parts, $nodeSrc );

		// Delete the duplicated <td> node.
		$node->parentNode->removeChild( $node );
		// This node was deleted, so don't continue processing on it.
		return $nextNode;
	}

	return true;
};

function isSimpleTemplatedSpan( $node ) {
	global $DOMDataUtils;
	global $DOMUtils;
	return $node->nodeName === 'SPAN'
&& DOMDataUtils::hasTypeOf( $node, 'mw:Transclusion' )
&& DOMUtils::allChildrenAreTextOrComments( $node );
}

function hoistTransclusionInfo( $env, $child, $tdNode ) {
	global $DOMDataUtils;
	global $Util;
	global $DOMUtils;
	$aboutId = $child->getAttribute( 'about' ) || '';
	// Hoist all transclusion information from the child
	// to the parent tdNode.
	$tdNode->setAttribute( 'typeof', $child->getAttribute( 'typeof' ) );
	$tdNode->setAttribute( 'about', $aboutId );
	$dataMW = DOMDataUtils::getDataMw( $child );
	$parts = $dataMW->parts;
	$dp = DOMDataUtils::getDataParsoid( $tdNode );
	$childDP = DOMDataUtils::getDataParsoid( $child );

	// In `handleTableCellTemplates`, we're creating a cell w/o dsr info.
	if ( !Util::isValidDSR( $dp->dsr ) ) {
		$dp->dsr = Util::clone( $childDP->dsr );
	}

	// Get the td and content source up to the transclusion start
	if ( $dp->dsr[ 0 ] < $childDP->dsr[ 0 ] ) {
		array_unshift( $parts, substr( $env->page->src, $dp->dsr[ 0 ], $childDP->dsr[ 0 ]/*CHECK THIS*/ ) );
	}

	// Add wikitext for the table cell content following the
	// transclusion. This is safe as we are currently only
	// handling a single transclusion in the content, which is
	// guaranteed to have a dsr that covers the transclusion
	// itself.
	if ( $childDP->dsr[ 1 ] < $dp->dsr[ 1 ] ) {
		$parts[] = substr( $env->page->src, $childDP->dsr[ 1 ], $dp->dsr[ 1 ]/*CHECK THIS*/ );
	}

	// Save the new data-mw on the tdNode
	DOMDataUtils::setDataMw( $tdNode, [ 'parts' => $parts ] );
	$dp->pi = $childDP->pi;
	DOMDataUtils::setDataMw( $child, null );

	// tdNode wraps everything now.
	// Remove template encapsulation from here on.
	// This simplifies the problem of analyzing the <td>
	// for additional fixups (|| Boo || Baz) by potentially
	// invoking 'reparseTemplatedAttributes' on split cells
	// with some modifications.
	while ( $child ) {
		if ( $child->nodeName === 'SPAN' && $child->getAttribute( 'about' ) === $aboutId ) {
			// Remove the encapsulation attributes. If there are no more attributes left,
			// the span wrapper is useless and can be removed.
			$child->removeAttribute( 'about' );
			$child->removeAttribute( 'typeof' );
			if ( DOMDataUtils::noAttrs( $child ) ) {
				$next = $child->firstChild || $child->nextSibling;
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
 * Collect potential attribute content.
 *
 * We expect this to be text nodes without a pipe character followed by one or
 * more nowiki spans, followed by a template encapsulation with pure-text and
 * nowiki content. Collection stops when encountering other nodes or a pipe
 * character.
 */
TableFixups::prototype::collectAttributishContent = function ( $env, $node, $templateWrapper ) use ( &$DOMDataUtils, &$DOMUtils ) {
	$buf = [];
	$nowikis = [];
	$transclusionNode = $templateWrapper
|| ( ( DOMDataUtils::hasTypeOf( $node, 'mw:Transclusion' ) ) ? $node : null );

	// Build the result.
	$buildRes = function () use ( &$buf, &$nowikis, &$transclusionNode ) {
		return [
			'txt' => implode( '', $buf ),
			'nowikis' => $nowikis,
			'transclusionNode' => $transclusionNode
		];
	};
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
		} elseif ( $child->nodeName !== 'SPAN' ) {
			// The idea here is that style attributes can only
			// be text/comment nodes, and nowiki-spans at best.
			// So, if we hit anything else, there is nothing more
			// to do here!
			return $buildRes();
		} else {
			$typeOf = $child->getAttribute( 'typeof' ) || '';
			if ( preg_match( '/^mw:Entity$/', $typeOf ) ) {
				$buf[] = $child->textContent;
			} elseif ( preg_match( '/^mw:Nowiki$/', $typeOf ) ) {
				// Nowiki span were added to protect otherwise
				// meaningful wikitext chars used in attributes.

				// Save the content.
				$nowikis[] = $child->textContent;
				// And add in a marker to splice out later.
				$buf[] = '<nowiki>';
			} elseif ( isSimpleTemplatedSpan( $child ) ) {
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
			} elseif ( $transclusionNode && ( !$child->hasAttribute( 'typeOf' ) )
&& $child->getAttribute( 'about' ) === $transclusionNode->getAttribute( 'about' )
&& DOMUtils::allChildrenAreTextOrComments( $child )
			) {
				// Continue accumulating only if we hit grouped template content
				$buf[] = $child->textContent;
			} else {
				return $buildRes();
			}
		}

		// Are we done accumulating?
		if ( preg_match( '/(?:^|[^|])\|(?:[^|]|$)/', JSUtils::lastItem( $buf ) ) ) {
			return $buildRes();
		}

		$child = $child->nextSibling;
	}

	return $buildRes();
};

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
 */

TableFixups::prototype::reparseTemplatedAttributes = function ( $env, $node, $templateWrapper ) use ( &$Sanitizer ) {
	// Collect attribute content and examine it
	$attributishContent = $this->collectAttributishContent( $env, $node, $templateWrapper );

	// Check for the pipe character in the attributish text.
	if ( !preg_match( '/^[^|]+\|([^|].*)?$/', $attributishContent->txt ) ) {
		return;
	}

	// Try to re-parse the attributish text content
	$attributishPrefix = preg_match( '/^[^|]+\|/', $attributishContent->txt )[ 0 ];

	// Splice in nowiki content.  We added in <nowiki> markers to prevent the
	// above regexps from matching on nowiki-protected chars.
	if ( preg_match( '/<nowiki>/', $attributishPrefix ) ) {
		$attributishPrefix = preg_replace( '/<nowiki>/', function () {
				// This is a little tricky.  We want to use the content from the
				// nowikis to reparse the string to kev/val pairs but the rule,
				// single_cell_table_args, will invariably get tripped up on
				// newlines which, to this point, were shuttled through in the
				// nowiki.  php's santizer will do this replace in attr vals so
				// it's probably a safe assumption ...
				return preg_replace( '/\s+/', ' ', array_shift( $attributishContent->nowikis ) );
		}, $attributishPrefix );
	}

	// re-parse the attributish prefix
	$attributeTokens = $this->tokenizer->
	tokenizeTableCellAttributes( $attributishPrefix, false );

	// No attributes => nothing more to do!
	if ( $attributeTokens instanceof $Error ) {
		return;
	}

	// Note that `row_syntax_table_args` (the rule used for tokenizing above)
	// returns an array consisting of [table_attributes, spaces, pipe]
	$attrs = $attributeTokens[ 0 ];

	// Found attributes; sanitize them
	// and transfer the sanitized attributes to the td node
	Sanitizer::applySanitizedArgs( $env, $node, $attrs );

	// If the transclusion node was embedded within the td node,
	// lift up the about group to the td node.
	$transclusionNode = $attributishContent->transclusionNode;
	if ( $transclusionNode !== null && $node !== $transclusionNode ) {
		hoistTransclusionInfo( $env, $transclusionNode, $node );
	}

	// Drop nodes that have been consumed by the reparsed attribute content.
	$n = $node->firstChild;
	while ( $n ) {
		if ( preg_match( '/[|]/', $n->textContent ) ) {
			// Remove the consumed prefix from the text node
			$nValue = ( $n->nodeName === '#text' ) ? $n->nodeValue : $n->textContent;
			// and convert it into a simple text node
			$node->replaceChild( $node->ownerDocument->createTextNode( preg_replace( '/^[^|]*[|]/', '', $nValue, 1 ) ), $n );
			break;
		} else {
			$next = $n->nextSibling;
			// content was consumed by attributes, so just drop it from the cell
			$node->removeChild( $n );
			$n = $next;
		}
	}
};

function needsReparsing( $node ) {
	global $DOMUtils;
	global $WTUtils;
	$testRE = ( $node->nodeName === 'TD' ) ? /* RegExp */ '/[|]/' : /* RegExp */ '/[!|]/';
	$child = $node->firstChild;
	while ( $child ) {
		if ( DOMUtils::isText( $child ) && preg_match( $testRE, $child->textContent ) ) {
			return true;
		} elseif ( $child->nodeName === 'SPAN' ) {
			if ( WTUtils::hasParsoidAboutId( $child ) && preg_match( $testRE, $child->textContent ) ) {
				return true;
			}
		}
		$child = $child->nextSibling;
	}

	return false;
}

TableFixups::prototype::handleTableCellTemplates = function ( $node, $env ) use ( &$WTUtils, &$DOMDataUtils, &$DOMUtils ) {
	// Don't bother with literal HTML nodes or nodes that don't need reparsing.
	if ( WTUtils::isLiteralHTMLNode( $node ) || !needsReparsing( $node ) ) {
		return true;
	}

	// If the cell didn't have attrs, extract and reparse templated attrs
	$about = null;
	$dp = DOMDataUtils::getDataParsoid( $node );
	$hasAttrs = !( $dp->tmp && $dp->tmp->noAttrs );

	if ( !$hasAttrs ) {
		$about = $node->getAttribute( 'about' );
		$templateWrapper = ( DOMUtils::hasTypeOf( $node, 'mw:Transclusion' ) ) ?
		$node : null;
		$this->reparseTemplatedAttributes( $env, $node, $templateWrapper );
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
		} elseif ( DOMUtils::isText( $child ) || isSimpleTemplatedSpan( $child ) ) {
			$cellName = strtolower( $node->nodeName );
			$hasSpanWrapper = !DOMUtils::isText( $child );
			$match = null;

			if ( $cellName === 'td' ) {
				$match = preg_match( '/^(.*?[^|])?\|\|([^|].*)?$/', $child->textContent );
			} else { /* cellName === 'th' */
				// Find the first match of || or !!
				$match1 = preg_match( '/^(.*?[^|])?\|\|([^|].*)?$/', $child->textContent );
				$match2 = preg_match( '/^(.*?[^!])?\!\!([^!].*)?$/', $child->textContent );
				if ( $match1 && $match2 ) {
					$match = ( count( $match1[ 1 ] || '' ) < count( $match2[ 1 ] || '' ) ) ? $match1 : $match2;
				} else {
					$match = $match1 || $match2;
				}
			}

			if ( $match ) {
				$child->textContent = $match[ 1 ] || '';

				$newCell = $ownerDoc->createElement( $cellName );
				if ( $hasSpanWrapper ) {
					// Fix up transclusion wrapping
					$about = $child->getAttribute( 'about' );
					hoistTransclusionInfo( $env, $child, $node );
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
				$newCell->appendChild( $ownerDoc->createTextNode( $match[ 2 ] || '' ) );
				$node->parentNode->insertBefore( $newCell, $node->nextSibling );

				// Set data-parsoid noAttrs flag
				$newCellDP = DOMDataUtils::getDataParsoid( $newCell );
				$newCellDP->tmp->noAttrs = true;
			}
		}

		$child = $next;
	}

	return true;
};

if ( gettype( $module ) === 'object' ) {
	$module->exports->TableFixups = $TableFixups;
}
