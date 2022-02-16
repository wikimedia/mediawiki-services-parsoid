<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\PP\Processors;

use Wikimedia\Assert\Assert;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Core\DomSourceRange;
use Wikimedia\Parsoid\Core\InternalException;
use Wikimedia\Parsoid\DOM\Comment;
use Wikimedia\Parsoid\DOM\Document;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\DOM\Text;
use Wikimedia\Parsoid\NodeData\DataParsoid;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Utils\WTUtils;
use Wikimedia\Parsoid\Wt2Html\Frame;

class WrapSectionsState {
	/** @var Env */
	private $env;

	/** @var Frame */
	private $frame;

	/** @var Element|DocumentFragment */
	private $rootNode;

	/**
	 * The next section debug ID
	 * @var int
	 */
	private $count = 1;

	/** @var Document */
	private $doc;

	/**
	 * Map of about ID to first element
	 * @var Element[]
	 */
	private $aboutIdMap = [];

	/** @var int */
	private $sectionNumber = 0;

	/** @var bool */
	private $inTemplate = false;

	/** @var WrapSectionsTplInfo[] */
	private $tplsAndExtsToExamine = [];

	/**
	 * @param Env $env
	 * @param Frame $frame
	 * @param Node $rootNode
	 */
	public function __construct(
		Env $env,
		Frame $frame,
		Node $rootNode
	) {
		$this->env = $env;
		$this->frame = $frame;
		$this->rootNode = $rootNode;
		$this->doc = $rootNode->ownerDocument;
	}

	/**
	 * Create a new section element
	 *
	 * @param Element|DocumentFragment $rootNode
	 * @param array<Section> &$sectionStack
	 * @param ?Section $currSection
	 * @param Node $node
	 * @param int $newLevel
	 * @param bool $pseudoSection
	 * @return Section
	 */
	private function createNewSection(
		Node $rootNode, array &$sectionStack,
		?Section $currSection, Node $node, int $newLevel,
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
		$section = new Section( $newLevel, $this->count++, $this->doc );

		/* Step 1. Get section stack to the right nesting level
		 * 1a. Pop stack till we have a higher-level section.
		 */
		$stack = &$sectionStack;
		$sc = count( $stack );
		while ( $sc > 0 && !( $stack[$sc - 1]->hasNestedLevel( $newLevel ) ) ) {
			array_pop( $stack );
			$sc--;
		}

		/* 1b. Push current section onto stack if it is a higher-level section */
		if ( $currSection && $currSection->hasNestedLevel( $newLevel ) ) {
			$stack[] = $currSection;
			$sc++;
		}

		/* Step 2: Add new section where it belongs: a parent section OR body */
		$parentSection = $sc > 0 ? $stack[$sc - 1] : null;
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
		} elseif ( $this->inTemplate ) {
			$section->setId( -1 );
		} else {
			$section->setId( $this->sectionNumber );
		}

		return $section;
	}

	/**
	 * @param Element $span
	 * @return bool
	 */
	private function isEmptySpan( Element $span ): bool {
		$n = $span->firstChild;
		while ( $n ) {
			if ( $n instanceof Element ) {
				return false;
			} elseif ( $n instanceof Text && !preg_match( '/^\s*$/D',  $n->nodeValue ) ) {
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
	 * @param ?Section $currSection
	 * @param Element|DocumentFragment $rootNode
	 * @return int
	 */
	private function wrapSectionsInDOM(
		?Section $currSection, Node $rootNode
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
			if ( !$this->inTemplate && WTUtils::isFirstEncapsulationWrapperNode( $node ) ) {
				DOMUtils::assertElt( $node );
				$about = $node->getAttribute( 'about' ) ?? '';
				$aboutSiblings = WTUtils::getAboutSiblings( $node, $about );
				$this->inTemplate = true;
				$tplInfo = new WrapSectionsTplInfo;
				$tplInfo->first = $node;
				$tplInfo->about = $about;
				$tplInfo->last = end( $aboutSiblings );
				$this->aboutIdMap[$about] = $node;

				// Collect a sequence of rendering transparent nodes starting at $node
				while ( $node ) {
					if ( WTUtils::isRenderingTransparentNode( $node ) || (
							DOMCompat::nodeName( $node ) === 'span' &&
							!WTUtils::isLiteralHTMLNode( $node ) &&
							$this->isEmptySpan( $node )
						)
					) {
						$tplInfo->rtContentNodes[] = $node;
						$node = $node->nextSibling;
					} else {
						break;
					}
				}

				if ( count( $tplInfo->rtContentNodes ) > 0 &&
					DOMUtils::isHeading( $node ) && !WTUtils::isLiteralHTMLNode( $node )
				) {
					// In this scenario, we can expand the section boundary to include these nodes
					// rather than start with the heading. This eliminates unnecessary conflicts
					// between section & template boundaries.
					$expandSectionBoundary = true;
					$next = $node->nextSibling;
				} else {
					// Reset to normal sectioning behavior!
					$node = $tplInfo->first;
					$tplInfo->rtContentNodes = [];
				}
			}

			// HTML <h*> tags don't get section numbers!
			if ( DOMUtils::isHeading( $node ) && !WTUtils::isLiteralHTMLNode( $node ) ) {
				DOMUtils::assertElt( $node ); // headings are elements
				$level = (int)DOMCompat::nodeName( $node )[1];

				// This could be just `$this->sectionNumber++` without the
				// complicated if-guard if T214538 were fixed in core;
				// see T213468 where this more-complicated behavior was
				// added to match core's eccentricities.
				$dp = DOMDataUtils::getDataParsoid( $node );
				if ( isset( $dp->tmp->headingIndex ) ) {
					$this->sectionNumber = $dp->tmp->headingIndex;
				}
				if ( $level < $highestSectionLevel ) {
					$highestSectionLevel = $level;
				}
				$currSection = $this->createNewSection(
					$rootNode, $sectionStack,
					$currSection, $node, $level, false
				);
				if ( $tplInfo && $expandSectionBoundary ) {
					foreach ( $tplInfo->rtContentNodes as $rtn ) {
						$currSection->container->insertBefore( $rtn, $node );
					}
					$tplInfo->firstSection = $currSection;
				}
				$addedNode = true;
			} elseif ( $node instanceof Element ) {
				$nestedHighestSectionLevel = $this->wrapSectionsInDOM( null, $node );
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
						$rootNode, $sectionStack,
						$currSection, $node, $nestedHighestSectionLevel, true
					);
					$addedNode = true;
				}
			}

			if ( $currSection && !$addedNode ) {
				$currSection->addNode( $node );
			}

			if ( $tplInfo && $tplInfo->first === $node ) {
				$tplInfo->firstSection = $currSection;
			}

			// Track exit from templated output
			if ( $tplInfo && $tplInfo->last === $node ) {
				if ( $currSection !== $tplInfo->firstSection ) {
					// The opening $node and closing $node of the template
					// are in different sections! This might require resolution.
					// While 'firstSection' could be null, if we get here,
					// 'lastSection' is guaranteed to always be non-null.
					$tplInfo->lastSection = $currSection;
					$this->tplsAndExtsToExamine[] = $tplInfo;
				}

				$tplInfo = null;
				$this->inTemplate = false;
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
	 * Is this a Parsoid-inserted section (vs. a section node generated by
	 * other page-components / content-generators like extensions)?
	 *
	 * @param Element $n
	 * @return bool
	 */
	private function isParsoidSection( Element $n ): bool {
		return DOMCompat::nodeName( $n ) === 'section' && $n->hasAttribute( 'data-mw-section-id' );
	}

	/**
	 * Find an ancestor that is a Parsoid-inserted section
	 *
	 * @param Node $n
	 * @return Node
	 */
	private function findSectionAncestor( Node $n ): Node {
		do {
			$n = DOMUtils::findAncestorOfName( $n, 'section' );
		} while ( $n && !self::isParsoidSection( $n ) );

		Assert::invariant( $n !== null, "Expected to find Parsoid-section ancestor" );
		return $n;
	}

	/**
	 * Get opening/closing DSR offset for the subtree rooted at $node.
	 * This handles scenarios where $node is a section or template wrapper
	 * and if a section, when it has leading/trailing non-element nodes
	 * that don't have recorded DSR values.
	 *
	 * @param Element $node
	 * @param bool $start
	 * @return ?int
	 */
	private function getDSR( Element $node, bool $start ): ?int {
		if ( !self::isParsoidSection( $node ) ) {
			$dsr = DOMDataUtils::getDataParsoid( $node )->dsr ?? null;
			if ( !$dsr ) {
				Assert::invariant(
					$node->hasAttribute( 'about' ),
					'Expected an about id'
				);
				$about = $node->getAttribute( 'about' );
				$dsr = DOMDataUtils::getDataParsoid( $this->aboutIdMap[$about] )->dsr;
			}

			return $start ? $dsr->start : $dsr->end;
		}

		$offset = 0;
		$c = $start ? $node->firstChild : $node->lastChild;
		while ( $c ) {
			if ( $c instanceof Text ) {
				$offset += strlen( $c->textContent );
			} elseif ( $c instanceof Comment ) {
				$offset += WTUtils::decodedCommentLength( $c );
			} else {
				DOMUtils::assertElt( $c );
				$ret = $this->getDSR( $c, $start );
				return $ret === null ? null : $ret + ( $start ? -$offset : $offset );
			}
			$c = $start ? $c->nextSibling : $c->previousSibling;
		}

		return -1;
	}

	/**
	 * FIXME: Duplicated with TableFixups code.
	 * @param array &$parts
	 * @param ?int $offset1
	 * @param ?int $offset2
	 * @throws InternalException
	 */
	private function fillDSRGap( array &$parts, ?int $offset1, ?int $offset2 ): void {
		if ( $offset1 === null || $offset2 === null ) {
			throw new InternalException();
		}
		if ( $offset1 < $offset2 ) {
			$parts[] = PHPUtils::safeSubstr( $this->frame->getSrcText(), $offset1,  $offset2 - $offset1 );
		}
	}

	/**
	 * FIXME: There is strong overlap with TableFixups code.
	 *
	 * $wrapper will hold tpl/ext encap info for the array of tpls/exts as well as
	 * content before, after and in between them. Right now, this will always be a
	 * <section> node, but not asserting this since code doesn't depend on it being so.
	 *
	 * @param Element $wrapper
	 * @param array $encapWrappers
	 */
	private function collapseWrappers( Element $wrapper, array $encapWrappers ) {
		$wrapperDp = DOMDataUtils::getDataParsoid( $wrapper );

		// Build up $parts, $pi to set up the combined transclusion info on $wrapper
		$parts = [];
		$pi = [];
		$index = 0;
		$prevDp = null;
		$haveTemplate = false;
		try {
			foreach ( $encapWrappers as $encapNode ) {
				$dp = DOMDataUtils::getDataParsoid( $encapNode );

				// Plug DSR gaps between encapWrappers
				if ( !$prevDp ) {
					$this->fillDSRGap( $parts, $wrapperDp->dsr->start, $dp->dsr->start );
				} else {
					$this->fillDSRGap( $parts, $prevDp->dsr->end, $dp->dsr->start );
				}

				if ( DOMUtils::hasTypeOf( $encapNode, "mw:Transclusion" ) ) {
					$haveTemplate = true;
					// Assimilate $encapNode's data-mw and data-parsoid pi info
					$dmw = DOMDataUtils::getDataMw( $encapNode );
					foreach ( $dmw->parts ?? [] as $part ) {
						// Template index is relative to other transclusions.
						// This index is used to extract whitespace information from
						// data-parsoid and that array only includes info for templates.
						// So skip over strings here.
						if ( !is_string( $part ) ) {
							$part = clone $part;
							if ( isset( $part->template ) ) {
								$part->template->i = $index++;
							} else {
								$part->templatearg->i = $index++;
							}
						}
						$parts[] = $part;
					}
					PHPUtils::pushArray( $pi, $dp->pi ?? [ [] ] );
				} else {
					// Where a non-template type is present, we are going to treat that
					// segment as a "string" in the parts array. So, we effectively treat
					// "mw:Transclusion" as a generic type that covers a single template
					// as well as a run of segments where at least one segment comes from
					// a template but others may be from other generators (ex: extensions).
					$this->fillDSRGap( $parts, $dp->dsr->start, $dp->dsr->end );
				}

				$prevDp = $dp;
			}

			if ( !$haveTemplate ) {
				throw new InternalException();
			}

			DOMUtils::addTypeOf( $wrapper, "mw:Transclusion" );
			$wrapperDp->pi = $pi;
			$this->fillDSRGap( $parts, $prevDp->dsr->end, $wrapperDp->dsr->end );
			DOMDataUtils::setDataMw( $wrapper, (object)[ 'parts' => $parts ] );
		} catch ( InternalException $e ) {
			// We don't have accurate template wrapping information.
			// Set typeof to 'mw:Placeholder' since 'mw:Transclusion'
			// typeof is not actionable without valid data-mw.
			//
			// FIXME:
			// 1. If we stop stripping section wrappers in the html->wt direction,
			//    we will need to add a DOMHandler for <section> or mw:Placeholder typeof
			//    on arbitrary Elements to traverse into children and serialize and
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
	 */
	private function resolveTplExtSectionConflicts() {
		$secRanges = [];
		'@phan-var array[] $secRanges';
		foreach ( $this->tplsAndExtsToExamine as $tplInfo ) {
			$s1 = $tplInfo->firstSection->container ??
				self::findSectionAncestor( $tplInfo->first );

			// guaranteed to be non-null
			$s2 = $tplInfo->lastSection->container;

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

			'@phan-var Element $start';  // @var Element $start
			'@phan-var Element $end';    // @var Element $end

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
					'@phan-var Element $n';  // @var Element $n
					if ( self::isParsoidSection( $n ) && $n->hasAttribute( 'about' ) ) {
						$about = $n->getAttribute( 'about' );
						break;
					}
					$n = $n->parentNode;
				}

				if ( !$about ) {
					// Not overlapping, not nested => new range
					$about = $this->env->newAboutId();
					$start->setAttribute( 'about', $about );
					$end->setAttribute( 'about', $about );
					$secRanges[$about] = [ 'start' => $start, 'end' => $end, 'encapWrappers' => [] ];
				}
			}
			$secRanges[$about]['encapWrappers'][] = $tplInfo->first;
		}

		// Process recorded ranges into new encapsulation information
		// that spans all content in that range.
		foreach ( $secRanges as $about => $range ) {
			// Ensure that all top level nodes of the range have the same about id
			for ( $n = $range['start']; $n !== $range['end']->nextSibling; $n = $n->nextSibling ) {
				Assert::invariant( self::isParsoidSection( $n ),
					"Encountered non-Parsoid-section node (" .
					DOMCompat::nodeName( $n ) .
					") while updating template wrappers" );
				$n->setAttribute( 'about', $about );
			}

			$dsr1 = $this->getDSR( $range['start'], true ); // Traverses non-tpl content => will succeed
			$dsr2 = $this->getDSR( $range['end'], false );  // Traverses non-tpl content => will succeed
			$dp = new DataParsoid;
			$dp->dsr = new DomSourceRange( $dsr1, $dsr2, null, null );
			DOMDataUtils::setDataParsoid( $range['start'], $dp );

			$this->collapseWrappers( $range['start'], $range['encapWrappers'] );
		}
	}

	/**
	 * DOM Postprocessor entry function to walk DOM rooted at $root
	 * and add <section> wrappers as necessary.
	 * Implements the algorithm documented @ mw:Parsing/Notes/Section_Wrapping
	 */
	public function run(): void {
		// 6 is the lowest possible level since we don't want
		// any nesting of h-tags in the lead section
		$leadSection = new Section( 6, 0, $this->doc );
		$leadSection->setId( 0 );

		$this->wrapSectionsInDOM( $leadSection, $this->rootNode );

		// There will always be a lead section, even if sometimes it only
		// contains whitespace + comments.
		$this->rootNode->insertBefore( $leadSection->container, $this->rootNode->firstChild );

		// Resolve template conflicts after all sections have been added to the DOM
		$this->resolveTplExtSectionConflicts();
	}
}
