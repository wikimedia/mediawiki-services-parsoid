<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/** @module */

namespace Parsoid;

$ContentUtils = require '../../../utils/ContentUtils.js'::ContentUtils;
$DOMDataUtils = require '../../../utils/DOMDataUtils.js'::DOMDataUtils;
$DOMUtils = require '../../../utils/DOMUtils.js'::DOMUtils;
$Util = require '../../../utils/Util.js'::Util;
$PipelineUtils = require '../../../utils/PipelineUtils.js'::PipelineUtils;
$DOMTraverser = require '../../../utils/DOMTraverser.js'::DOMTraverser;

class UnpackDOMFragments {
	public static function hasBadNesting( $targetNode, $fragment ) {
		// SSS FIXME: This is not entirely correct. This is only
		// looking for nesting of identical tags. But, HTML tree building
		// has lot more restrictions on nesting. It seems the simplest way
		// to get all the rules right is to (serialize + reparse).

		function isNestableElement( $nodeName ) {
			// A-tags cannot ever be nested inside each other at any level.
			// This is the one scenario we definitely have to handle right now.
			// We need a generic robust solution for other nesting scenarios.
			return $nodeName !== 'A';
		}

		return !isNestableElement( $targetNode->nodeName )
&& DOMUtils::treeHasElement( $fragment, $targetNode->nodeName );
	}

	public static function fixUpMisnestedTagDSR( $targetNode, $fragment, $env ) {
		// Currently, this only deals with A-tags
		if ( $targetNode->nodeName !== 'A' ) {
			return;
		}

		// Walk the fragment till you find an 'A' tag and
		// zero out DSR width for all tags from that point on.
		// This also requires adding span wrappers around
		// bare text from that point on.

		// QUICK FIX: Add wrappers unconditionally and strip unneeded ones
		// Since this scenario should be rare in practice, I am going to
		// go with this simple solution.
		PipelineUtils::addSpanWrappers( $fragment->childNodes );

		$resetDSR = false;
		$currOffset = 0;
		$dsrFixer = new DOMTraverser();
		$fixHandler = function ( $node ) use ( &$DOMUtils, &$DOMDataUtils ) {
			if ( DOMUtils::isElt( $node ) ) {
				$dp = DOMDataUtils::getDataParsoid( $node );
				if ( $node->nodeName === 'A' ) {
					$resetDSR = true;
				}
				if ( $resetDSR ) {
					if ( $dp->dsr && $dp->dsr[ 0 ] ) {
						$currOffset = $dp->dsr[ 1 ] = $dp->dsr[ 0 ];
					} else {
						$dp->dsr = [ $currOffset, $currOffset ];
					}
					$dp->misnested = true;
				} elseif ( $dp->tmp->wrapper ) {
					// Unnecessary wrapper added above -- strip it.
					$next = $node->firstChild || $node->nextSibling;
					DOMUtils::migrateChildren( $node, $node->parentNode, $node );
					$node->parentNode->removeChild( $node );
					return $next;
				}
			}
			return true;
		};
		$dsrFixer->addHandler( null, $fixHandler );
		$dsrFixer->traverse( $fragment->firstChild );
		$fixHandler( $fragment );
	}

	public static function addDeltaToDSR( $node, $delta ) {
		// Add 'delta' to dsr[0] and dsr[1] for nodes in the subtree
		// node's dsr has already been updated
		$child = $node->firstChild;
		while ( $child ) {
			if ( DOMUtils::isElt( $child ) ) {
				$dp = DOMDataUtils::getDataParsoid( $child );
				if ( $dp->dsr ) {
					// SSS FIXME: We've exploited partial DSR information
					// in propagating DSR values across the DOM.  But, worth
					// revisiting at some point to see if we want to change this
					// so that either both or no value is present to eliminate these
					// kind of checks.
					//
					// Currently, it can happen that one or the other
					// value can be null.  So, we should try to udpate
					// the dsr value in such a scenario.
					if ( gettype( $dp->dsr[ 0 ] ) === 'number' ) {
						$dp->dsr[ 0 ] += $delta;
					}
					if ( gettype( $dp->dsr[ 1 ] ) === 'number' ) {
						$dp->dsr[ 1 ] += $delta;
					}
				}
				self::addDeltaToDSR( $child, $delta );
			}
			$child = $child->nextSibling;
		}
	}

	public static function fixAbouts( $env, $node, $aboutIdMap ) {
		$c = $node->firstChild;
		while ( $c ) {
			if ( DOMUtils::isElt( $c ) ) {
				if ( $c->hasAttribute( 'about' ) ) {
					$cAbout = $c->getAttribute( 'about' );
					// Update about
					$newAbout = $aboutIdMap->get( $cAbout );
					if ( !$newAbout ) {
						$newAbout = $env->newAboutId();
						$aboutIdMap->set( $cAbout, $newAbout );
					}
					$c->setAttribute( 'about', $newAbout );
				}
				self::fixAbouts( $env, $c, $aboutIdMap );
			}
			$c = $c->nextSibling;
		}
	}

	public static function makeChildrenEncapWrappers( $node, $about ) {
		PipelineUtils::addSpanWrappers( $node->childNodes );

		$c = $node->firstChild;
		while ( $c ) {
			// FIXME: This unconditionally sets about on children
			// This is currently safe since all of them are nested
			// inside a transclusion, but do we need future-proofing?
			$c->setAttribute( 'about', $about );
			$c = $c->nextSibling;
		}
	}

	/**
	 * DOMTraverser handler that unpacks DOM fragments which were injected in the
	 * token pipeline.
	 * @param {Node} node
	 * @param {MWParserEnvironment} env
	 */
	public static function unpackDOMFragments( $node, $env ) {
		if ( !DOMUtils::isElt( $node ) ) { return true;
  }

		// sealed fragments shouldn't make it past this point
		if ( !DOMUtils::hasTypeOf( $node, 'mw:DOMFragment' ) ) { return true;
  }

		$dp = DOMDataUtils::getDataParsoid( $node );

		// Replace this node and possibly a sibling with node.dp.html
		$fragmentParent = $node->parentNode;
		$dummyNode = $node->ownerDocument->createElement( $fragmentParent->nodeName );

		Assert::invariant( preg_match( '/^mwf/', $dp->html ) );

		$nodes = $env->fragmentMap->get( $dp->html );

		if ( $dp->tmp && $dp->tmp->isHtmlExt ) {
			// FIXME: This is a silly workaround for foundationwiki which has the
			// "html" extension tag which lets through arbitrary content and
			// often does so in a way that doesn't consider that we'd like to
			// encapsulate it.  For example, it closes the tag in the middle
			// of style tag content to insert a template and then closes the style
			// tag in another "html" extension tag.  The balance proposal isn't
			// its friend.
			//
			// This works because importNode does attribute error checking, whereas
			// parsing does not.  A better fix would be to use one ownerDocument
			// for the entire parse, so no adoption is needed.  See T179082
			$html = implode( '', array_map( $nodes, function ( $n ) {return ContentUtils::toXML( $n );
   } ) );
			ContentUtils::ppToDOM( $env, $html, [ 'node' => $dummyNode ] );
		} else {
			$nodes->forEach( function ( $n ) use ( &$dummyNode ) {
					$imp = $dummyNode->ownerDocument->importNode( $n, true );
					$dummyNode->appendChild( $imp );
			}
			);
			DOMDataUtils::visitAndLoadDataAttribs( $dummyNode );
		}

		$contentNode = $dummyNode->firstChild;

		if ( DOMUtils::hasTypeOf( $node, 'mw:Transclusion' ) ) {
			// Ensure our `firstChild` is an element to add annotation.  At present,
			// we're unlikely to end up with translusion annotations on fragments
			// where span wrapping hasn't occurred (ie. link contents, since that's
			// placed on the anchor itself) but in the future, nowiki spans may be
			// omitted or new uses for dom fragments found.  For now, the test case
			// necessitating this is an edgy link-in-link scenario:
			// [[Test|{{1x|[[Hmm|Something <sup>strange</sup>]]}}]]
			PipelineUtils::addSpanWrappers( $dummyNode->childNodes );
			// Reset `contentNode`, since the `firstChild` may have changed in
			// span wrapping.
			$contentNode = $dummyNode->firstChild;
			// Transfer typeof, data-mw, and param info
			// about attributes are transferred below.
			DOMDataUtils::setDataMw( $contentNode, Util::clone( DOMDataUtils::getDataMw( $node ) ) );
			DOMDataUtils::addTypeOf( $contentNode, 'mw:Transclusion' );
			DOMDataUtils::getDataParsoid( $contentNode )->pi = $dp->pi;
		}

		// Update DSR:
		//
		// - Only update DSR for content that came from cache.
		// - For new DOM fragments from this pipeline,
		// previously-computed DSR is valid.
		// - EXCEPTION: fostered content from tables get their DSR reset
		// to zero-width.
		// - FIXME: We seem to also be doing this for new extension content,
		// which is the only place still using `setDSR`.
		//
		// There is currently no DSR for DOMFragments nested inside
		// transclusion / extension content (extension inside template
		// content etc).
		// TODO: Make sure that is the only reason for not having a DSR here.
		$dsr = $dp->dsr;
		if ( $dsr && ( $dp->tmp->setDSR || $dp->tmp->fromCache || $dp->fostered ) ) {
			$cnDP = DOMDataUtils::getDataParsoid( $contentNode );
			if ( DOMUtils::hasTypeOf( $contentNode, 'mw:Transclusion' ) ) {
				// FIXME: An old comment from c28f137 said we just use dsr[0] and
				// dsr[1] since tag-widths will be incorrect for reuse of template
				// expansions.  The comment was removed in ca9e760.
				$cnDP->dsr = [ $dsr[ 0 ], $dsr[ 1 ] ];
			} elseif ( DOMUtils::matchTypeOf( $contentNode, /* RegExp */ '/^mw:(Nowiki|Extension(\/[^\s]+))$/' ) !== null ) {
				$cnDP->dsr = $dsr;
			} else { // non-transcluded images
				$cnDP->dsr = [ $dsr[ 0 ], $dsr[ 1 ], 2, 2 ];
				// Reused image -- update dsr by tsrDelta on all
				// descendents of 'firstChild' which is the <figure> tag
				$tsrDelta = $dp->tmp->tsrDelta;
				if ( $tsrDelta ) {
					self::addDeltaToDSR( $contentNode, $tsrDelta );
				}
			}
		}

		if ( $dp->tmp->fromCache ) {
			// Replace old about-id with new about-id that is
			// unique to the global page environment object.
			//
			// <figure>s are reused from cache. Note that figure captions
			// can contain multiple independent transclusions. Each one
			// of those individual transclusions should get a new unique
			// about id. Hence a need for an aboutIdMap and the need to
			// walk the entire tree.
			self::fixAbouts( $env, $dummyNode, new Map() );
		}

		// If the fragment wrapper has an about id, it came from template
		// annotating (the wrapper was an about sibling) and should be transferred
		// to top-level nodes after span wrapping.  This should happen regardless
		// of whether we're coming `fromCache` or not.
		// FIXME: Presumably we have a nesting issue here if this is a cached
		// transclusion.
		$about = $node->getAttribute( 'about' );
		if ( $about !== null ) {
			// Span wrapping may not have happened for the transclusion above if
			// the fragment is not the first encapsulation wrapper node.
			PipelineUtils::addSpanWrappers( $dummyNode->childNodes );
			$n = $dummyNode->firstChild;
			while ( $n ) {
				$n->setAttribute( 'about', $about );
				$n = $n->nextSibling;
			}
		}

		$nextNode = $node->nextSibling;

		if ( self::hasBadNesting( $fragmentParent, $dummyNode ) ) {
			/* -----------------------------------------------------------------------
			 * If fragmentParent is an A element and the fragment contains another
			 * A element, we have an invalid nesting of A elements and needs fixing up
			 *
			 * doc1: ... fragmentParent -> [... dummyNode=mw:DOMFragment, ...] ...
			 *
			 * 1. Change doc1:fragmentParent -> [... "#unique-hash-code", ...] by replacing
			 *    node with the "#unique-hash-code" text string
			 *
			 * 2. str = parentHTML.replace(#unique-hash-code, dummyHTML)
			 *    We now have a HTML string with the bad nesting. We will now use the HTML5
			 *    parser to parse this HTML string and give us the fixed up DOM
			 *
			 * 3. ParseHTML(str) to get
			 *    doc2: [BODY -> [[fragmentParent -> [...], nested-A-tag-from-dummyNode, ...]]]
			 *
			 * 4. Replace doc1:fragmentParent with doc2:body.childNodes
			 * ----------------------------------------------------------------------- */
			$timestamp = ( time() )->toString();
			$fragmentParent->replaceChild( $node->ownerDocument->createTextNode( $timestamp ), $node );

			// If fragmentParent has an about, it presumably is nested inside a template
			// Post fixup, its children will surface to the encapsulation wrapper level.
			// So, we have to fix them up so they dont break the encapsulation.
			//
			// Ex: {{echo|[http://foo.com This is [[bad]], very bad]}}
			//
			// In this example, the <a> corresponding to Foo is fragmentParent and has an about.
			// dummyNode is the DOM corresponding to "This is [[bad]], very bad". Post-fixup
			// "[[bad]], very bad" are at encapsulation level and need about ids.
			$about = $fragmentParent->getAttribute( 'about' );
			if ( $about !== null ) {
				self::makeChildrenEncapWrappers( $dummyNode, $about );
			}

			// Set zero-dsr width on all elements that will get split
			// in dummyNode's tree to prevent selser-based corruption
			// on edits to a page that contains badly nested tags.
			self::fixUpMisnestedTagDSR( $fragmentParent, $dummyNode, $env );

			$dummyHTML = ContentUtils::ppToXML( $dummyNode, [
					'innerXML' => true,
					// We just added some span wrappers and we need to keep
					// that tmp info so the unnecessary ones get stripped.
					// Should be fine since tmp was stripped before packing.
					'keepTmp' => true
				]
			);
			$parentHTML = ContentUtils::ppToXML( $fragmentParent );

			$p = $fragmentParent->previousSibling;

			// We rely on HTML5 parser to fixup the bad nesting (see big comment above)
			$newDoc = DOMUtils::parseHTML( str_replace( $timestamp, $dummyHTML, $parentHTML ) );
			DOMUtils::migrateChildrenBetweenDocs( $newDoc->body, $fragmentParent->parentNode, $fragmentParent );

			if ( !$p ) {
				$p = $fragmentParent->parentNode->firstChild;
			} else {
				$p = $p->nextSibling;
			}

			while ( $p !== $fragmentParent ) {
				DOMDataUtils::visitAndLoadDataAttribs( $p );
				$p = $p->nextSibling;
			}

			// Set nextNode to the previous-sibling of former fragmentParent (which will get deleted)
			// This will ensure that all nodes will get handled
			$nextNode = $fragmentParent->previousSibling;

			// fragmentParent itself is useless now
			$fragmentParent->parentNode->removeChild( $fragmentParent );
		} else {
			// Move the content nodes over and delete the placeholder node
			DOMUtils::migrateChildren( $dummyNode, $fragmentParent, $node );
			$node->parentNode->removeChild( $node );
		}

		return $nextNode;
	}
}

if ( gettype( $module ) === 'object' ) {
	$module->exports->UnpackDOMFragments = $UnpackDOMFragments;
}
