<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\PP\Handlers;

use Wikimedia\Assert\Assert;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Core\DomSourceRange;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\NodeData\TempData;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMTraverser;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\PipelineUtils;
use Wikimedia\Parsoid\Utils\Utils;

class UnpackDOMFragments {
	/**
	 * @param Node $targetNode
	 * @param DocumentFragment $fragment
	 * @return bool
	 */
	private static function hasBadNesting(
		Node $targetNode, DocumentFragment $fragment
	): bool {
		// SSS FIXME: This is not entirely correct. This is only
		// looking for nesting of identical tags. But, HTML tree building
		// has lot more restrictions on nesting. It seems the simplest way
		// to get all the rules right is to (serialize + reparse).

		// A-tags cannot ever be nested inside each other at any level.
		// This is the one scenario we definitely have to handle right now.
		// We need a generic robust solution for other nesting scenarios.
		return DOMCompat::nodeName( $targetNode ) === 'a' &&
			DOMUtils::treeHasElement( $fragment, DOMCompat::nodeName( $targetNode ) );
	}

	/**
	 * @param Element $targetNode
	 * @param DocumentFragment $fragment
	 * @param Env $env
	 */
	public static function fixUpMisnestedTagDSR(
		Element $targetNode, DocumentFragment $fragment, Env $env
	): void {
		// Currently, this only deals with A-tags
		if ( DOMCompat::nodeName( $targetNode ) !== 'a' ) {
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
		$dsrFixer = new DOMTraverser();
		$newOffset = DOMDataUtils::getDataParsoid( $targetNode )->dsr->end ?? null;
		$fixHandler = static function ( Node $node ) use ( &$resetDSR, &$newOffset ) {
			if ( $node instanceof Element ) {
				$dp = DOMDataUtils::getDataParsoid( $node );
				if ( !$resetDSR && DOMCompat::nodeName( $node ) === 'a' ) {
					$resetDSR = true;
					// Wrap next siblings to the 'A', since they can end up bare
					// after the misnesting
					PipelineUtils::addSpanWrappers( $node->parentNode->childNodes, $node );
					return $node;
				}
				if ( $resetDSR ) {
					if ( $newOffset === null ) {
						// We end up here when $targetNode is part of encapsulated content.
						// Till we add logic to prevent that from happening, we need this fallback.
						if ( isset( $dp->dsr->start ) ) {
							$newOffset = $dp->dsr->start;
						}
					}
					$dp->dsr = new DomSourceRange( $newOffset, $newOffset, null, null );
					$dp->misnested = true;
				} elseif ( $dp->getTempFlag( TempData::WRAPPER ) ) {
					// Unnecessary wrapper added above -- strip it.
					$next = $node->firstChild ?: $node->nextSibling;
					DOMUtils::migrateChildren( $node, $node->parentNode, $node );
					$node->parentNode->removeChild( $node );
					return $next;
				}
			}
			return true;
		};
		$dsrFixer->addHandler( null, $fixHandler );
		$dsrFixer->traverse( $env, $fragment->firstChild );
		$fixHandler( $fragment );
	}

	/**
	 * @param Env $env
	 * @param Node $node
	 * @param array &$aboutIdMap
	 */
	private static function fixAbouts( Env $env, Node $node, array &$aboutIdMap = [] ): void {
		$c = $node->firstChild;
		while ( $c ) {
			if ( $c instanceof Element ) {
				if ( $c->hasAttribute( 'about' ) ) {
					$cAbout = $c->getAttribute( 'about' );
					// Update about
					$newAbout = $aboutIdMap[$cAbout] ?? null;
					if ( !$newAbout ) {
						$newAbout = $env->newAboutId();
						$aboutIdMap[$cAbout] = $newAbout;
					}
					$c->setAttribute( 'about', $newAbout );
				}
				self::fixAbouts( $env, $c, $aboutIdMap );
			}
			$c = $c->nextSibling;
		}
	}

	/**
	 * @param DocumentFragment $domFragment
	 * @param string $about
	 */
	private static function makeChildrenEncapWrappers(
		DocumentFragment $domFragment, string $about
	): void {
		PipelineUtils::addSpanWrappers( $domFragment->childNodes );

		$c = $domFragment->firstChild;
		while ( $c ) {
			/**
			 * We just span wrapped the child nodes, so it's safe to assume
			 * they're all Elements.
			 *
			 * @var Element $c
			 */
			'@phan-var Element $c';
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
	 * @param Node $node
	 * @param Env $env
	 * @return bool|Node
	 */
	public static function handler( Node $node, Env $env ) {
		if ( !$node instanceof Element ) {
			return true;
		}

		// sealed fragments shouldn't make it past this point
		if ( !DOMUtils::hasTypeOf( $node, 'mw:DOMFragment' ) ) {
			return true;
		}

		$dp = DOMDataUtils::getDataParsoid( $node );

		// Replace this node and possibly a sibling with node.dp.html
		$fragmentParent = $node->parentNode;

		Assert::invariant( str_starts_with( $dp->html, 'mwf' ), '' );
		$domFragment = $env->getDOMFragment( $dp->html );

		$contentNode = $domFragment->firstChild;

		if ( DOMUtils::hasTypeOf( $node, 'mw:Transclusion' ) ) {
			// Ensure our `firstChild` is an element to add annotation.  At present,
			// we're unlikely to end up with translusion annotations on fragments
			// where span wrapping hasn't occurred (ie. link contents, since that's
			// placed on the anchor itself) but in the future, nowiki spans may be
			// omitted or new uses for dom fragments found.  For now, the test case
			// necessitating this is an edgy link-in-link scenario:
			//   [[Test|{{1x|[[Hmm|Something <sup>strange</sup>]]}}]]
			PipelineUtils::addSpanWrappers( $domFragment->childNodes );
			// Reset `contentNode`, since the `firstChild` may have changed in
			// span wrapping.
			$contentNode = $domFragment->firstChild;
			DOMUtils::assertElt( $contentNode );
			// Transfer typeof, data-mw, and param info
			// about attributes are transferred below.
			DOMDataUtils::setDataMw( $contentNode, Utils::clone( DOMDataUtils::getDataMw( $node ) ) );
			DOMUtils::addTypeOf( $contentNode, 'mw:Transclusion' );
			DOMDataUtils::getDataParsoid( $contentNode )->pi = $dp->pi ?? null;
		}

		// Update DSR:
		//
		// - Only update DSR for content that came from cache.
		// - For new DOM fragments from this pipeline,
		//   previously-computed DSR is valid.
		// - EXCEPTION: fostered content from tables get their DSR reset
		//   to zero-width.
		// - FIXME: We seem to also be doing this for new extension content,
		//   which is the only place still using `setDSR`.
		//
		// There is currently no DSR for DOMFragments nested inside
		// transclusion / extension content (extension inside template
		// content etc).
		// TODO: Make sure that is the only reason for not having a DSR here.
		$dsr = $dp->dsr ?? null;
		if ( $dsr && !(
			!$dp->getTempFlag( TempData::SET_DSR )
			&& !$dp->getTempFlag( TempData::FROM_CACHE )
			&& empty( $dp->fostered ) )
		) {
			DOMUtils::assertElt( $contentNode );
			$cnDP = DOMDataUtils::getDataParsoid( $contentNode );
			if ( DOMUtils::hasTypeOf( $contentNode, 'mw:Transclusion' ) ) {
				// FIXME: An old comment from c28f137 said we just use dsr->start and
				// dsr->end since tag-widths will be incorrect for reuse of template
				// expansions.  The comment was removed in ca9e760.
				$cnDP->dsr = new DomSourceRange( $dsr->start, $dsr->end, null, null );
			} elseif (
				DOMUtils::matchTypeOf( $contentNode, '/^mw:(Nowiki|Extension(\/[^\s]+))$/' ) !== null
			) {
				$cnDP->dsr = $dsr;
			} else { // non-transcluded images
				$cnDP->dsr = new DomSourceRange( $dsr->start, $dsr->end, 2, 2 );
			}
		}

		if ( $dp->getTempFlag( TempData::FROM_CACHE ) ) {
			// Replace old about-id with new about-id that is
			// unique to the global page environment object.
			//
			// <figure>s are reused from cache. Note that figure captions
			// can contain multiple independent transclusions. Each one
			// of those individual transclusions should get a new unique
			// about id. Hence a need for an aboutIdMap and the need to
			// walk the entire tree.
			self::fixAbouts( $env, $domFragment );
		}

		// If the fragment wrapper has an about id, it came from template
		// annotating (the wrapper was an about sibling) and should be transferred
		// to top-level nodes after span wrapping.  This should happen regardless
		// of whether we're coming `fromCache` or not.
		// FIXME: Presumably we have a nesting issue here if this is a cached
		// transclusion.
		$about = $node->getAttribute( 'about' ) ?? '';
		if ( $about !== '' ) {
			// Span wrapping may not have happened for the transclusion above if
			// the fragment is not the first encapsulation wrapper node.
			PipelineUtils::addSpanWrappers( $domFragment->childNodes );
			$n = $domFragment->firstChild;
			while ( $n ) {
				DOMUtils::assertElt( $n );
				$n->setAttribute( 'about', $about );
				$n = $n->nextSibling;
			}
		}

		$nextNode = $node->nextSibling;

		if ( self::hasBadNesting( $fragmentParent, $domFragment ) ) {
			DOMUtils::assertElt( $fragmentParent );
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
			$timestamp = (string)time();
			$fragmentParent->replaceChild( $node->ownerDocument->createTextNode( $timestamp ), $node );

			// If fragmentParent has an about, it presumably is nested inside a template
			// Post fixup, its children will surface to the encapsulation wrapper level.
			// So, we have to fix them up so they dont break the encapsulation.
			//
			// Ex: {{1x|[http://foo.com This is [[bad]], very bad]}}
			//
			// In this example, the <a> corresponding to Foo is fragmentParent and has an about.
			// dummyNode is the DOM corresponding to "This is [[bad]], very bad". Post-fixup
			// "[[bad]], very bad" are at encapsulation level and need about ids.
			$about = $fragmentParent->getAttribute( 'about' ) ?? '';
			if ( $about !== '' ) {
				self::makeChildrenEncapWrappers( $domFragment, $about );
			}

			// Set zero-dsr width on all elements that will get split
			// in dummyNode's tree to prevent selser-based corruption
			// on edits to a page that contains badly nested tags.
			self::fixUpMisnestedTagDSR( $fragmentParent, $domFragment, $env );

			$dummyHTML = ContentUtils::ppToXML( $domFragment, [
					'innerXML' => true,
					// We just added some span wrappers and we need to keep
					// that tmp info so the unnecessary ones get stripped.
					// Should be fine since tmp was stripped before packing.
					'keepTmp' => true
				]
			);

			// Empty the fragment since we've serialized its children and
			// removing it asserts everything has been migrated out
			DOMCompat::replaceChildren( $domFragment );

			$parentHTML = ContentUtils::ppToXML( $fragmentParent );

			$p = $fragmentParent->previousSibling;

			// We rely on HTML5 parser to fixup the bad nesting (see big comment above)
			$newFragment = DOMUtils::parseHTMLToFragment(
				$fragmentParent->ownerDocument,
				str_replace( $timestamp, $dummyHTML, $parentHTML )
			);
			DOMUtils::migrateChildren(
				$newFragment, $fragmentParent->parentNode, $fragmentParent
			);

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
			DOMUtils::migrateChildren( $domFragment, $fragmentParent, $node );
			$node->parentNode->removeChild( $node );
		}

		$env->removeDOMFragment( $dp->html );

		return $nextNode;
	}
}
