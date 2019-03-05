<?php // lint >= 99.9
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module */

namespace Parsoid;

$Consts = require( '../../../config/WikitextConstants.js' )::WikitextConstants;
$DOMDataUtils = require( '../../../utils/DOMDataUtils.js' )::DOMDataUtils;
$DOMUtils = require( '../../../utils/DOMUtils.js' )::DOMUtils;
$Util = require( '../../../utils/Util.js' )::Util;
$WTUtils = require( '../../../utils/WTUtils.js' )::WTUtils;

/**
 */
function stripMarkerMetas( $node, $env ) {
	global $DOMDataUtils;
	$rtTestMode = $env->conf->parsoid->rtTestMode;

	$metaType = $node->getAttribute( 'typeof' );
	if ( !$metaType ) {
		return true;
	}

	// Sometimes a non-tpl meta node might get the mw:Transclusion typeof
	// element attached to it. So, check if the node has data-mw,
	// in which case we also have to keep it.
	$metaTestRE = /* RegExp */ '/(?:^|\s)mw:(StartTag|EndTag|TSRMarker|Transclusion)\/?[^\s]*/';

	if ( ( !$rtTestMode && $metaType === 'mw:Placeholder/StrippedTag' )
||			( preg_match( $metaTestRE, $metaType ) && !DOMDataUtils::validDataMw( $node ) )
	) {
		$nextNode = $node->nextSibling;
		$node->parentNode->removeChild( $node );
		// stop the traversal, since this node is no longer in the DOM.
		return $nextNode;
	} else {
		return true;
	}
}

/**
 */
function handleEmptyElements( $node, $env, $unused, $tplInfo ) {
	global $DOMUtils;
	global $Consts;
	global $DOMDataUtils;
	global $Util;
	if ( !DOMUtils::isElt( $node )
||			!Consts\Output\FlaggedEmptyElts::has( $node->nodeName )
||			!DOMUtils::nodeEssentiallyEmpty( $node )
||			Array::from( $node->attributes )->some( function ( $a ) use ( &$DOMDataUtils, &$tplInfo, &$Util ) {
					return ( $a->name !== DOMDataUtils\DataObjectAttrName() )
&&						( !$tplInfo || $a->name !== 'about' || !Util::isParsoidObjectId( $a->value ) );
				}
			)
	) {
		return true;
	}

	// The node is known to be empty and a deletion candidate
	// * If node is part of template content, it can be deleted
	//   (since we know it has no attributes, it won't be the
	//    first node that has about, typeof, and other attrs)
	// * If not, we add the mw-empty-elt class so that wikis
	//   can decide what to do with them.
	if ( $tplInfo ) {
		$nextNode = $node->nextSibling;
		$node->parentNode->removeChild( $node );
		return $nextNode;
	} else {
		$node->classList->add( 'mw-empty-elt' );
		return true;
	}
}

// FIXME: Leaky Cite-specific info
function isRefText( $node ) {
	global $DOMUtils;
	while ( !DOMUtils::atTheTop( $node ) ) {
		if ( $node->classList->contains( 'mw-reference-text' ) ) {
			return true;
		}
		$node = $node->parentNode;
	}
	return false;
}

// Whitespace in this function refers to [ \t] only
function trimWhiteSpace( $node ) {
	global $DOMUtils;
	global $WTUtils;
	$c = null; $next = null; $prev = null;

	// Trim leading ws (on the first line)
	for ( $c = $node->firstChild;  $c;  $c = $next ) {
		$next = $c->nextSibling;
		if ( DOMUtils::isText( $c ) && preg_match( '/^[ \t]*$/', $c->data ) ) {
			$node->removeChild( $c );
		} elseif ( !WTUtils::isRenderingTransparentNode( $c ) ) {
			break;
		}
	}

	if ( DOMUtils::isText( $c ) ) {
		$c->data = preg_replace( '/^[ \t]+/', '', $c->data, 1 );
	}

	// Trim trailing ws (on the last line)
	for ( $c = $node->lastChild;  $c;  $c = $prev ) {
		$prev = $c->previousSibling;
		if ( DOMUtils::isText( $c ) && preg_match( '/^[ \t]*$/', $c->data ) ) {
			$node->removeChild( $c );
		} elseif ( !WTUtils::isRenderingTransparentNode( $c ) ) {
			break;
		}
	}

	if ( DOMUtils::isText( $c ) ) {
		$c->data = preg_replace( '/[ \t]+$/', '', $c->data, 1 );
	}
}

/**
 * Perform some final cleanup and save data-parsoid attributes on each node.
 */
function cleanupAndSaveDataParsoid( $node, $env, $atTopLevel, $tplInfo ) {
	global $DOMUtils;
	global $DOMDataUtils;
	global $WTUtils;
	global $Consts;
	global $Util;
	if ( !DOMUtils::isElt( $node ) ) {
		return true;
	}

	$dp = DOMDataUtils::getDataParsoid( $node );
	$next = null;

	// Delete from data parsoid, wikitext originating autoInsertedEnd info
	if ( $dp->autoInsertedEnd && !WTUtils::hasLiteralHTMLMarker( $dp )
&&			Consts\WTTagsWithNoClosingTags::has( $node->nodeName )
	) {
		$dp->autoInsertedEnd = null;
	}

	$isFirstEncapsulationWrapperNode = ( $tplInfo && $tplInfo->first === $node )
||		// Traversal isn't done with tplInfo for section tags, but we should
		// still clean them up as if they are the head of encapsulation.
		WTUtils::isParsoidSectionTag( $node );

	// Remove dp.src from elements that have valid data-mw and dsr.
	// This should reduce data-parsoid bloat.
	//
	// Presence of data-mw is a proxy for us knowing how to serialize
	// this content from HTML. Token handlers should strip src for
	// content where data-mw isn't necessary and html2wt knows how to
	// handle the HTML markup.
	$validDSR = DOMDataUtils::validDataMw( $node ) && Util::isValidDSR( $dp->dsr );
	$isPageProp = ( $node->nodeName === 'META'
&&		preg_match( '/^mw\:PageProp\/(.*)$/', $node->getAttribute( 'property' ) ) );
	if ( $validDSR && !$isPageProp ) {
		$dp->src = null;
	} elseif ( $isFirstEncapsulationWrapperNode && ( !$atTopLevel || !$dp->tsr ) ) {
		// Transcluded nodes will not have dp.tsr set
		// and don't need dp.src either.
		$dp->src = null;
	}

	// Remove tsr
	if ( $dp->tsr ) {
		$dp->tsr = null;
	}

	// Remove temporary information
	$dp->tmp = null;

	// Make dsr zero-range for fostered content
	// to prevent selser from duplicating this content
	// outside the table from where this came.
	//
	// But, do not zero it out if the node has template encapsulation
	// information.  That will be disastrous (see T54638, T54488).
	if ( $dp->fostered && $dp->dsr && !$isFirstEncapsulationWrapperNode ) {
		$dp->dsr[ 0 ] = $dp->dsr[ 1 ];
	}

	if ( $atTopLevel ) {
		// Strip nowiki spans from encapsulated content but leave behind
		// wrappers on root nodes since they have valid about ids and we
		// don't want to break the about-chain by stripping the wrapper
		// and associated ids (we cannot add an about id on the nowiki-ed
		// content since that would be a text node).
		if ( $tplInfo && !WTUtils::hasParsoidAboutId( $node )
&&				preg_match( '/^mw:Nowiki$/', $node->getAttribute( 'typeof' ) )
		) {
			DOMUtils::migrateChildren( $node, $node->parentNode, $node->nextSibling );
			// Replace the span with an empty text node.
			// (better for perf instead of deleting the node)
			$next = $node->ownerDocument->createTextNode( '' );
			$node->parentNode->replaceChild( $next, $node );
			return $next;
		}

		// Trim whitespace from some wikitext markup
		// not involving explicit HTML tags (T157481)
		if ( !WTUtils::hasLiteralHTMLMarker( $dp )
&&				Consts\WikitextTagsWithTrimmableWS::has( $node->nodeName )
		) {
			trimWhiteSpace( $node );
		}

		$discardDataParsoid = $env->discardDataParsoid;

		// Strip data-parsoid from templated content, where unnecessary.
		if ( $tplInfo
			// Always keep info for the first node
			 && !$isFirstEncapsulationWrapperNode
			// We can't remove data-parsoid from inside <references> text,
			// as that's the only HTML representation we have left for it.
			 && !isRefText( $node )
			// FIXME: We can't remove dp from nodes with stx information
			// because the serializer uses stx information in some cases to
			// emit the right newline separators.
			//
			// For example, "a\n\nb" and "<p>a</p><p>b/p>" both generate
			// identical html but serialize to different wikitext.
			//
			// This is only needed for the last top-level node .
			 && ( !$dp->stx || $tplInfo->last !== $node )
		) {
			$discardDataParsoid = true;
		}

		DOMDataUtils::storeDataAttribs( $node, [
				'discardDataParsoid' => $discardDataParsoid,
				// Even though we're passing in the `env`, this is the only place
				// we want the storage to happen, so don't refactor this in there.
				'storeInPageBundle' => $env->pageBundle,
				'env' => $env
			]
		);
	}// We only need the env in this case.


	return true;
}

if ( gettype( $module ) === 'object' ) {
	$module->exports->cleanupAndSaveDataParsoid = $cleanupAndSaveDataParsoid;
	$module->exports->handleEmptyElements = $handleEmptyElements;
	$module->exports->stripMarkerMetas = $stripMarkerMetas;
}
