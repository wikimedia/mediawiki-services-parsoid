<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\PP\Processors;

use DOMComment;
use DOMDocumentFragment;
use DOMElement;
use DOMNode;
use DOMText;
use Wikimedia\Assert\Assert;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Core\DomSourceRange;
use Wikimedia\Parsoid\Core\InternalException;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Utils\WTUtils;
use Wikimedia\Parsoid\Wt2Html\Frame;
use Wikimedia\Parsoid\Wt2Html\Wt2HtmlDOMProcessor;

class WrapSections implements Wt2HtmlDOMProcessor {
	/**
	 * Get page source between the requested offsets
	 *
	 * @param Frame $frame
	 * @param int $s
	 * @param int $e
	 * @return string
	 */
	private function getSrc( Frame $frame, int $s, int $e ): string {
		return PHPUtils::safeSubstr( $frame->getSrcText(), $s, $e - $s );
	}

	/**
	 * Create a new section element
	 *
	 * @param array &$state
	 * @param DOMElement|DOMDocumentFragment $rootNode
	 * @param array<Section> &$sectionStack
	 * @param ?array $tplInfo
	 * @param ?Section $currSection
	 * @param DOMNode $node
	 * @param int $newLevel
	 * @param bool $pseudoSection
	 * @return Section
	 */
	private function createNewSection(
		array &$state, DOMNode $rootNode, array &$sectionStack,
		?array $tplInfo, ?Section $currSection, DOMNode $node, int $newLevel,
		bool $pseudoSection
	): Section {
		/* Structure for regular (editable or not) sections
		 *   <section data-mw-section-id="..">
		 *     <h*>..</h*>
		 *     ..
		 *   </section>
		 *
		 * Lead sections and pseudo-sections won't have <h*> or <div> tags
		 */
		$section = new Section( $newLevel, $state['count']++, $state['doc'] );

		/* Step 1. Get section stack to the right nesting level
		 * 1a. Pop stack till we have a higher-level section.
		 */
		$stack = &$sectionStack;
		while ( count( $stack ) > 0 && !( PHPUtils::lastItem( $stack )->hasNestedLevel( $newLevel ) ) ) {
			array_pop( $stack );
		}

		/* 1b. Push current section onto stack if it is a higher-level section */
		if ( $currSection && $currSection->hasNestedLevel( $newLevel ) ) {
			$stack[] = $currSection;
		}

		/* Step 2: Add new section where it belongs: a parent section OR body */
		$parentSection = count( $stack ) > 0 ? PHPUtils::lastItem( $stack ) : null;
		if ( $parentSection ) {
			$parentSection->addSection( $section );
		} else {
			$rootNode->insertBefore( $section->container, $node );
		}

		/* Step 3: Add <h*> to the <section> */
		$section->addNode( $node );

		/* Step 4: Assign data-mw-section-id attribute
		 *
		 * CX wants <section> tags with a distinguishing attribute so that
		 * it can differentiate between its internal use of <section> tags
		 * with what Parsoid adds. So, we will add a data-mw-section-id
		 * attribute always.
		 *
		 * data-mw-section-id = 0 for the lead section
		 * data-mw-section-id = -1 for non-editable sections
		 *     Note that templated content cannot be edited directly.
		 * data-mw-section-id = -2 for pseudo sections
		 * data-mw-section-id > 0 for everything else and this number
		 *     matches PHP parser / Mediawiki's notion of that section.
		 *
		 * The code here handles uneditable sections because of templating.
		 */
		if ( $pseudoSection ) {
			$section->setId( -2 );
		} elseif ( $state['inTemplate'] ) {
			$section->setId( -1 );
		} else {
			$section->setId( $state['sectionNumber'] );
		}

		return $section;
	}

	/**
	 * @param DOMElement $span
	 * @return bool
	 */
	private function isEmptySpan( DOMElement $span ): bool {
		$n = $span->firstChild;
		while ( $n ) {
			if ( $n instanceof DOMElement ) {
				return false;
			} elseif ( $n instanceof DOMText && !preg_match( '/^\s*$/D',  $n->nodeValue ) ) {
				return false;
			}
			$n = $n->nextSibling;
		}
		return true;
	}

	/**
	 * Walk the DOM and add <section> wrappers where required.
	 * This is the workhorse code that wrapSections relies on.
	 *
	 * @param array &$state
	 * @param ?Section $currSection
	 * @param DOMElement|DOMDocumentFragment $rootNode
	 * @return int
	 */
	private function wrapSectionsInDOM(
		array &$state, ?Section $currSection, DOMNode $rootNode
	): int {
		// Since template wrapping is done and template wrappers are well-nested,
		// we can reset template state for every subtree.
		$tplInfo = null;
		$sectionStack = [];
		$highestSectionLevel = 7;
		$node = $rootNode->firstChild;
		while ( $node ) {
			$next = $node->nextSibling;
			$addedNode = false;
			$expandSectionBoundary = false;

			// Track entry into templated output
			if ( !$state['inTemplate'] && WTUtils::isFirstEncapsulationWrapperNode( $node ) ) {
				DOMUtils::assertElt( $node );
				$about = $node->getAttribute( 'about' ) ?? '';
				$aboutSiblings = WTUtils::getAboutSiblings( $node, $about );
				$state['inTemplate'] = true;
				$tplInfo = [
					'first' => $node,
					'about' => $about,
					'last' => end( $aboutSiblings ),
					'rtContentNodes' => [] // Rendering-transparent content before a heading
				];
				$state['aboutIdMap'][$about] = $tplInfo;

				// Collect a sequence of rendering transparent nodes starting at $node
				while ( $node ) {
					if ( WTUtils::isRenderingTransparentNode( $node ) || (
							$node->nodeName === 'span' &&
							!WTUtils::isLiteralHTMLNode( $node ) &&
							$this->isEmptySpan( $node )
						)
					) {
						$tplInfo['rtContentNodes'][] = $node;
						$node = $node->nextSibling;
					} else {
						break;
					}
				}

				if ( count( $tplInfo['rtContentNodes'] ) > 0 &&
					DOMUtils::isHeading( $node ) && !WTUtils::isLiteralHTMLNode( $node )
				) {
					// In this scenario, we can expand the section boundary to include these nodes
					// rather than start with the heading. This eliminates unnecessary conflicts
					// between section & template boundaries.
					$expandSectionBoundary = true;
					$next = $node->nextSibling;
				} else {
					// Reset to normal sectioning behavior!
					$node = $tplInfo['first'];
					$tplInfo['rtContentNodes'] = [];
				}
			}

			// HTML <h*> tags don't get section numbers!
			if ( DOMUtils::isHeading( $node ) && !WTUtils::isLiteralHTMLNode( $node ) ) {
				DOMUtils::assertElt( $node ); // headings are elements
				$level = (int)$node->nodeName[1];

				// This could be just `state.sectionNumber++` without the
				// complicated if-guard if T214538 were fixed in core;
				// see T213468 where this more-complicated behavior was
				// added to match core's eccentricities.
				$dp = DOMDataUtils::getDataParsoid( $node );
				if ( isset( $dp->tmp->headingIndex ) ) {
					$state['sectionNumber'] = $dp->tmp->headingIndex;
				}
				if ( $level < $highestSectionLevel ) {
					$highestSectionLevel = $level;
				}
				$currSection = $this->createNewSection(
					$state, $rootNode, $sectionStack,
					$tplInfo && !$expandSectionBoundary ? $tplInfo : null,
					$currSection, $node, $level, false
				);
				if ( $tplInfo && $expandSectionBoundary ) {
					foreach ( $tplInfo['rtContentNodes'] as $rtn ) {
						$currSection->container->insertBefore( $rtn, $node );
					}
					$tplInfo['firstSection'] = $currSection;
				}
				$addedNode = true;
			} elseif ( $node instanceof DOMElement ) {
				$nestedHighestSectionLevel = $this->wrapSectionsInDOM( $state, null, $node );
				if ( $currSection && !$currSection->hasNestedLevel( $nestedHighestSectionLevel ) ) {
					// If we find a higher level nested section,
					// (a) Make current section non-editable
					// (b) There are 2 options here best illustrated with an example.
					//     Consider the wiktiext below.
					//       <div>
					//       =1=
					//       b
					//       </div>
					//       c
					//       =2=
					//     1. Create a new pseudo-section to wrap '$node'
					//        There will be a <section> around the <div> which includes 'c'.
					//     2. Don't create the pseudo-section by setting '$currSection = null'
					//        But, this can leave some content outside any top-level section.
					//        'c' will not be in any section.
					// The code below implements strategy 1.
					$currSection->setId( -1 );
					$currSection = $this->createNewSection(
						$state, $rootNode, $sectionStack, $tplInfo,
						$currSection, $node, $nestedHighestSectionLevel, true
					);
					$addedNode = true;
				}
			}

			if ( $currSection && !$addedNode ) {
				$currSection->addNode( $node );
			}

			if ( $tplInfo && $tplInfo['first'] === $node ) {
				$tplInfo['firstSection'] = $currSection;
			}

			// Track exit from templated output
			if ( $tplInfo && $tplInfo['last'] === $node ) {
				if ( $currSection !== $tplInfo['firstSection'] ) {
					// The opening $node and closing $node of the template
					// are in different sections! This might require resolution.
					// While 'firstSection' could be null, if we get here,
					// 'lastSection' is guaranteed to always be non-null.
					$tplInfo['lastSection'] = $currSection;
					$state['tplsAndExtsToExamine'][] = $tplInfo;
				}

				$tplInfo = null;
				$state['inTemplate'] = false;
			}

			$node = $next;
		}

		// The last section embedded in a non-body DOM element
		// should always be marked non-editable since it will have
		// the closing tag (ex: </div>) showing up in the source editor
		// which we cannot support in a visual editing $environment.
		if ( $currSection && !DOMUtils::atTheTop( $rootNode ) ) {
			$currSection->setId( -1 );
		}

		return $highestSectionLevel;
	}

	/**
	 * Get opening/closing DSR offset for the subtree rooted at $node.
	 * This handles scenarios where $node is a section or template wrapper
	 * and if a section, when it has leading/trailing non-element nodes
	 * that don't have recorded DSR values.
	 *
	 * @param array $state
	 * @param DOMElement $node
	 * @param bool $start
	 * @return ?int
	 */
	private function getDSR( array $state, DOMElement $node, bool $start ): ?int {
		if ( $node->nodeName !== 'section' ) {
			$dsr = DOMDataUtils::getDataParsoid( $node )->dsr ?? null;
			if ( !$dsr ) {
				Assert::invariant(
					$node->hasAttribute( 'about' ),
					'Expected an about id'
				);
				$about = $node->getAttribute( 'about' );
				$tplInfo = $state['aboutIdMap'][$about];
				$dsr = DOMDataUtils::getDataParsoid( $tplInfo['first'] )->dsr;
			}

			return $start ? $dsr->start : $dsr->end;
		}

		$offset = 0;
		$c = $start ? $node->firstChild : $node->lastChild;
		while ( $c ) {
			if ( $c instanceof DOMText ) {
				$offset += strlen( $c->textContent );
			} elseif ( $c instanceof DOMComment ) {
				$offset += WTUtils::decodedCommentLength( $c );
			} else {
				DOMUtils::assertElt( $c );
				$ret = $this->getDSR( $state, $c, $start );
				return $ret === null ? null : $ret + ( $start ? -$offset : $offset );
			}
			$c = $start ? $c->nextSibling : $c->previousSibling;
		}

		return -1;
	}

	/**
	 * FIXME: Duplicated with TableFixups code.
	 * @param array &$parts
	 * @param Frame $frame
	 * @param ?int $offset1
	 * @param ?int $offset2
	 * @throws InternalException
	 */
	private function fillDSRGap( array &$parts, Frame $frame, ?int $offset1, ?int $offset2 ): void {
		if ( $offset1 === null || $offset2 === null ) {
			throw new InternalException();
		}
		if ( $offset1 < $offset2 ) {
			$parts[] = PHPUtils::safeSubstr( $frame->getSrcText(), $offset1,  $offset2 - $offset1 );
		}
	}

	/**
	 * FIXME: There is strong overlap with TableFixups code.
	 *
	 * $wrapper will hold tpl/ext encap info for the array of tpls/exts as well as
	 * content before, after and in between them. Right now, this will always be a
	 * <section> node, but not asserting this since code doesn't depend on it being so.
	 *
	 * @param Frame $frame
	 * @param DOMElement $wrapper
	 * @param array $encapWrappers
	 */
	private function collapseWrappers( Frame $frame, DOMElement $wrapper, array $encapWrappers ) {
		$wrapperDp = DOMDataUtils::getDataParsoid( $wrapper );

		// Build up $parts, $pi to set up the combined transclusion info on $wrapper
		$parts = [];
		$pi = [];
		$index = 0;
		$prev = null;
		$prevDp = null;
		$haveTemplate = false;
		try {
			foreach ( $encapWrappers as $i => $encapNode ) {
				$dp = DOMDataUtils::getDataParsoid( $encapNode );

				// Plug DSR gaps between encapWrappers
				if ( !$prevDp ) {
					$this->fillDSRGap( $parts, $frame, $wrapperDp->dsr->start, $dp->dsr->start );
				} else {
					$this->fillDSRGap( $parts, $frame, $prevDp->dsr->end, $dp->dsr->start );
				}

				$typeOf = $encapNode->getAttribute( 'typeof' );
				if ( DOMUtils::hasTypeOf( $encapNode, "mw:Transclusion" ) ) {
					$haveTemplate = true;
					// Assimilate $encapNode's data-mw and data-parsoid pi info
					$dmw = DOMDataUtils::getDataMw( $encapNode );
					foreach ( $dmw->parts ?? [] as $part ) {
						if ( !is_string( $part ) ) {
							$part = clone $part;
							// This index in the template object is expected to be
							// relative to other template objects.
							$part->template->i = $index++;
						}
						$parts[] = $part;
					}
					$pi = array_merge( $pi, $dp->pi ?? [ [] ] );
				} else {
					// Where a non-template type is present, we are going to treat that
					// segment as a "string" in the parts array. So, we effectively treat
					// "mw:Transclusion" as a generic type that covers a single template
					// as well as a run of segments where at least one segment comes from
					// a template but others may be from other generators (ex: extensions).
					$this->fillDSRGap( $parts, $frame, $dp->dsr->start, $dp->dsr->end );
				}

				$prev = $encapNode;
				$prevDp = $dp;
			}

			if ( !$haveTemplate ) {
				throw new InternalException();
			}

			DOMUtils::addTypeOf( $wrapper, "mw:Transclusion" );
			$wrapperDp->pi = $pi;
			$this->fillDSRGap( $parts, $frame, $prevDp->dsr->end, $wrapperDp->dsr->end );
			DOMDataUtils::setDataMw( $wrapper, (object)[ 'parts' => $parts ] );
		} catch ( InternalException $e ) {
			// We don't have accurate template wrapping information.
			// Set typeof to 'mw:Placeholder' since 'mw:Transclusion'
			// typeof is not actionable without valid data-mw.
			//
			// FIXME:
			// 1. If we stop stripping section wrappers in the html->wt direction,
			//    we will need to add a DOMHandler for <section> or mw:Placeholder typeof
			//    on arbitrary DOMElements to traverse into children and serialize and
			//    prevent page corruption.
			// 2. This may be a good place to collect stats for T191641#6357136
			// 3. Maybe we need a special error typeof rather than mw:Placeholder
			$wrapper->setAttribute( 'typeof', 'mw:Placeholder' );
		}
	}

	/**
	 * Section wrappers and encapsulation wrappers can conflict because of
	 * partial overlaps. This method identifies those conflicts and fixes up
	 * the encapsulation by expanding those ranges as necessary.
	 *
	 * @param array &$state
	 */
	private function resolveTplExtSectionConflicts( array &$state ) {
		$secRanges = [];
		'@phan-var array[] $secRanges';
		foreach ( $state['tplsAndExtsToExamine'] as $tplInfo ) {
			$s1 = $tplInfo['firstSection']->container ??
				DOMUtils::findAncestorOfName( $tplInfo['first'], 'section' );

			// guaranteed to be non-null
			$s2 = $tplInfo['lastSection']->container;

			// Find a common ancestor of s1 and s2 (could be s1 or s2)
			$s2Ancestors = DOMUtils::pathToRoot( $s2 );
			$s1Ancestors = [];
			$n = 0;
			$ancestor = $s1;
			while ( !in_array( $ancestor, $s2Ancestors, true ) ) {
				$s1Ancestors[] = $ancestor;
				$ancestor = $ancestor->parentNode;
				$n++;
			}

			// ancestor is now the common ancestor of s1 and s2
			$s1Ancestors[] = $ancestor;
			$n++;

			// Set up start/end of the new encapsulation range
			if ( $ancestor === $s1 || $ancestor === $s2 ) {
				$start = $ancestor;
				$end = $ancestor;
			} else {
				// While creating a new section (see createNewSection), it only
				// gets added where its parent is either another section,
				// or body, so all ancestors are themselves sections, or body.
				$start = $s1Ancestors[$n - 2];
				$i = array_search( $ancestor, $s2Ancestors, true );
				$end = $s2Ancestors[$i - 1];
			}

			'@phan-var DOMElement $start';  // @var DOMElement $start
			'@phan-var DOMElement $end';    // @var DOMElement $end

			// Add new OR update existing range
			if ( $start->hasAttribute( 'about' ) ) {
				// Overlaps with an existing range.
				$about = $start->getAttribute( 'about' );
				if ( !$end->hasAttribute( 'about' ) ) {
					// Extend existing range till $end
					$secRanges[$about]['end'] = $end;
					$end->setAttribute( 'about', $about );
				} else {
					Assert::invariant( $end->getAttribute( 'about' ) === $about,
						"Expected end-range about id to be $about instead of " .
						$end->getAttribute( 'about' ) . " in the overlap scenario." );
				}
			} else {
				// Check for nesting in another range.  Since $start and $end
				// are siblings, this is sufficient to know the entire range
				// is nested
				$about = null;
				$n = $start->parentNode;
				$body = DOMCompat::getBody( $start->ownerDocument );
				while ( $n !== $body ) {
					'@phan-var DOMElement $n';  // @var DOMElement $n
					if ( $n->nodeName === 'section' && $n->hasAttribute( 'about' ) ) {
						$about = $n->getAttribute( 'about' );
						break;
					}
					$n = $n->parentNode;
				}

				if ( !$about ) {
					// Not overlapping, not nested => new range
					$about = $state['env']->newAboutId();
					$start->setAttribute( 'about', $about );
					$end->setAttribute( 'about', $about );
					$secRanges[$about] = [ 'start' => $start, 'end' => $end, 'encapWrappers' => [] ];
				}
			}
			$secRanges[$about]['encapWrappers'][] = $tplInfo['first'];
		}

		// Process recorded ranges into new encapsulation information
		// that spans all content in that range.
		foreach ( $secRanges as $about => $range ) {
			// Ensure that all top level nodes of the range have the same about id
			for ( $n = $range['start']; $n !== $range['end']->nextSibling; $n = $n->nextSibling ) {
				Assert::invariant( $n->nodeName === 'section',
					"Encountered non-section node ({$n->nodeName}) while updating template wrappers" );
				$n->setAttribute( 'about', $about );
			}

			$dsr1 = $this->getDSR( $state, $range['start'], true ); // Traverses non-tpl content => will succeed
			$dsr2 = $this->getDSR( $state, $range['end'], false );  // Traverses non-tpl content => will succeed
			DOMDataUtils::setDataParsoid( $range['start'],
				(object)[ 'dsr' => new DomSourceRange( $dsr1, $dsr2, null, null ) ] );

			$this->collapseWrappers( $state['frame'], $range['start'], $range['encapWrappers'] );
		}
	}

	/**
	 * DOM Postprocessor entry function to walk DOM rooted at $root
	 * and add <section> wrappers as necessary.
	 * Implements the algorithm documented @ mw:Parsing/Notes/Section_Wrapping
	 *
	 * @inheritDoc
	 */
	public function run(
		Env $env, DOMNode $root, array $options = [], bool $atTopLevel = false
	): void {
		'@phan-var DOMElement|DOMDocumentFragment $root';  // @var DOMElement|DOMDocumentFragment $root

		if ( !$env->getWrapSections() ) {
			return;
		}

		$doc = $root->ownerDocument;
		// 6 is the lowest possible level since we don't want
		// any nesting of h-tags in the lead section
		$leadSection = new Section( 6, 0, $doc );
		$leadSection->setId( 0 );

		// Global $state
		$state = [
			'env' => $env,
			'frame' => $options['frame'],
			'count' => 1,
			'doc' => $doc,
			'rootNode' => $root,
			'aboutIdMap' => [], // Maps about id to $tplInfo
			'sectionNumber' => 0,
			'inTemplate' => false,
			'tplsAndExtsToExamine' => []
		];
		$this->wrapSectionsInDOM( $state, $leadSection, $root );

		// There will always be a lead section, even if sometimes it only
		// contains whitespace + comments.
		$root->insertBefore( $leadSection->container, $root->firstChild );

		// Resolve template conflicts after all sections have been added to the DOM
		$this->resolveTplExtSectionConflicts( $state );
	}
}
