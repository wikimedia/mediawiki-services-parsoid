<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\PP\Processors;

use Wikimedia\Parsoid\Core\DomSourceRange;
use Wikimedia\Parsoid\DOM\Document;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;
use Wikimedia\Parsoid\NodeData\DataParsoid;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\WTUtils;
use Wikimedia\Parsoid\Wt2Html\Frame;

class AnnotationDOMRangeBuilder extends DOMRangeBuilder {
	/** @var MigrateTrailingNLs */
	private $migrateTrailingNls;

	/**
	 * AnnotationDOMRangeBuilder constructor.
	 * @param Document $document
	 * @param Frame $frame
	 */
	public function __construct( Document $document, Frame $frame ) {
		parent::__construct( $document, $frame );
		$this->migrateTrailingNls = new MigrateTrailingNLs();
	}

	/**
	 * @param Node $node
	 */
	private function wrapAnnotationsInTree( Node $node ): void {
		try {
			$annRanges = $this->findWrappableMetaRanges( $node );
		} catch ( RangeBuilderException $e ) {
			$this->env->log( 'warn', 'The annotation ranges could not be fully detected. ' .
				' Annotation processing cancelled. ' );
			return;
		}
		foreach ( $annRanges as $range ) {
			if ( ( DOMDataUtils::getDataParsoid( $range->startElem )->misnested ?? false ) ||
				( DOMDataUtils::getDataParsoid( $range->endElem )->misnested ?? false ) ) {
				continue;
			}

			$actualRangeStart = DOMDataUtils::getDataParsoid( $range->start )->dsr->start;
			$actualRangeEnd = DOMDataUtils::getDataParsoid( $range->end )->dsr->end;

			if ( DOMUtils::isFosterablePosition( $range->start ) ) {
				$newStart = $range->start;
				while ( DOMUtils::isFosterablePosition( $newStart ) ) {
					$newStart = $newStart->parentNode;
				}
				$range->start = $newStart;
			}

			if ( DOMUtils::isFosterablePosition( $range->end ) ) {
				$newEnd = $range->end;
				while ( DOMUtils::isFosterablePosition( $newEnd ) ) {
					$newEnd = $newEnd->parentNode;
				}
				$range->end = $newEnd;
			}

			if ( $range->startElem !== $range->start ) {
				$actualRangeStart = DOMDataUtils::getDataParsoid( $range->start )->dsr->start;
				$this->moveRangeStart( $range, $range->start );
			}
			if ( $range->endElem !== $range->end ) {
				$actualRangeEnd = DOMDataUtils::getDataParsoid( $range->end )->dsr->end;
				$this->moveRangeEnd( $range, $range->end );
			}

			$isExtended = $this->isExtended( $range );
			if ( $isExtended ) {
				$this->makeUneditable( $range, $actualRangeStart, $actualRangeEnd );
			}
			$this->setMetaDataMwForRange( $range, $isExtended );
		}
	}

	/**
	 * Makes the DOM range between $range->startElem and $range->endElem uneditable by wrapping
	 * it into a <div> (for block ranges) or <span> (for inline ranges) with the mw:ExtendedAnnRange
	 * type.
	 * @param DOMRangeInfo $range
	 * @param int|null $actualRangeStart
	 * @param int|null $actualRangeEnd
	 */
	private function makeUneditable( DOMRangeInfo $range, ?int $actualRangeStart, ?int $actualRangeEnd ) {
		$parent = $range->startElem->parentNode;

		$node = $range->startElem;
		$inline = true;
		while ( $node !== $range->endElem ) {
			$node = $node->nextSibling;
			if ( $node instanceof Element && DOMUtils::hasBlockTag( $node ) ) {
				$inline = false;
				break;
			}
		}

		$wrap = $parent->ownerDocument->createElement( $inline ? 'span' : 'div' );
		$parent->insertBefore( $wrap, $range->startElem );

		$toMove = $range->startElem;
		while ( $toMove !== $range->endElem ) {
			$nextToMove = $toMove->nextSibling;
			$wrap->appendChild( $toMove );
			$toMove = $nextToMove;
		}
		$wrap->appendChild( $toMove );

		$wrap->setAttribute( "typeof", "mw:ExtendedAnnRange" );

		// Ensure template continuity is not broken
		$about = $range->startElem->getAttribute( "about" );
		if ( $about ) {
			$wrap->setAttribute( "about", $about );
		}
		$dp = new DataParsoid();
		$dp->autoInsertedStart = true;
		$dp->autoInsertedEnd = true;
		$dp->dsr = new DomSourceRange( $actualRangeStart, $actualRangeEnd, 0, 0 );
		DOMDataUtils::setDataParsoid( $wrap, $dp );
		$openRanges = [];
		$this->removeNestedRanges( $wrap, $openRanges );
	}

	/**
	 * Moves the start of the range to the designated node
	 * @param DOMRangeInfo $range the range to modify
	 * @param Node $node the new start of the range
	 */
	private function moveRangeStart( DOMRangeInfo $range, Node $node ): void {
		$startMeta = $range->startElem;
		$startDataParsoid = DOMDataUtils::getDataParsoid( $startMeta );
		if ( $node instanceof Element ) {
			if ( DOMCompat::nodeName( $node ) === "p" && $node->firstChild === $startMeta ) {
				// If the first child of "p" is the meta, and it gets moved, then it got mistakenly
				// pulled inside the paragraph, and the paragraph dsr that gets computed includes
				// it - which may lead to the tag getting duplicated on roundtrip. Hence, we
				// adjust the dsr of the paragraph in that case. We also don't consider the meta
				// tag to have been moved in that case.
				$pDataParsoid = DOMDataUtils::getDataParsoid( $node );
				$pDataParsoid->dsr->start = $startDataParsoid->dsr->end;
			} else {
				$startDataParsoid->wasMoved = true;
			}
		}
		$node = $this->getStartConsideringFosteredContent( $node );
		$node->parentNode->insertBefore( $startMeta, $node );
		if ( $node instanceof Element ) {
			// Ensure template continuity is not broken
			$about = $node->getAttribute( "about" );
			if ( $about ) {
				$startMeta->setAttribute( "about", $about );
			}
		}
		$range->start = $startMeta;
	}

	/**
	 * Moves the start of the range to the designated node
	 * @param DOMRangeInfo $range the range to modify
	 * @param Node $node the new start of the range
	 */
	private function moveRangeEnd( DOMRangeInfo $range, Node $node ): void {
		$endMeta = $range->endElem;
		$endDataParsoid = DOMDataUtils::getDataParsoid( $endMeta );

		if ( $node instanceof Element ) {
			$endMetaWasLastChild = $node->lastChild === $endMeta;

			// Migrate $endMeta and ensure template continuity is not broken
			$node->parentNode->insertBefore( $endMeta, $node->nextSibling );
			$about = $node->getAttribute( "about" );
			if ( $about ) {
				$endMeta->setAttribute( "about", $about );
			}

			if ( ( DOMCompat::nodeName( $node ) === "p" ) && $endMetaWasLastChild ) {
				// If the last child of "p" is the meta, and it gets moved, then it got mistakenly
				// pulled inside the paragraph, and the paragraph dsr that gets computed includes
				// it - which may lead to the tag getting duplicated on roundtrip. Hence, we
				// adjust the dsr of the paragraph in that case. We also don't consider the meta
				// tag to have been moved in that case.
				$pDataParsoid = DOMDataUtils::getDataParsoid( $node );
				$pDataParsoid->dsr->end = $endDataParsoid->dsr->start;
				$prevLength = strlen( $node->textContent ?? '' );
				$this->migrateTrailingNls->doMigrateTrailingNLs( $node, $this->env );
				$newLength = strlen( $node->textContent ?? '' );
				if ( $prevLength != $newLength ) {
					$pDataParsoid->dsr->end -= ( $prevLength - $newLength );
				}
			} else {
				$endDataParsoid->wasMoved = true;
				DOMDataUtils::setDataParsoid( $endMeta, $endDataParsoid );
			}
		}
		$range->end = $endMeta;
	}

	/**
	 * Returns whether one of the ends of the range has been moved, which corresponds to an extended
	 * range.
	 * @param DOMRangeInfo $range
	 * @return bool
	 */
	private function isExtended( DOMRangeInfo $range ): bool {
		$startDataParsoid = DOMDataUtils::getDataParsoid( $range->startElem );
		$endDataParsoid = DOMDataUtils::getDataParsoid( $range->endElem );

		return ( $startDataParsoid->wasMoved ?? false ) || ( $endDataParsoid->wasMoved ?? false );
	}

	/**
	 * Sets the data-mw attribute for meta tags of the provided range
	 * @param DOMRangeInfo $range range whose start and end element needs to be to modified
	 * @param bool $isExtended whether the range got extended
	 */
	private function setMetaDataMwForRange( DOMRangeInfo $range, bool $isExtended ): void {
		$startDataMw = DOMDataUtils::getDataMw( $range->startElem );
		$endDataMw = DOMDataUtils::getDataMw( $range->endElem );

		$startDataMw->extendedRange = $isExtended;
		$startDataMw->wtOffsets = DOMDataUtils::getDataParsoid( $range->startElem )->tsr;
		$endDataMw->wtOffsets = DOMDataUtils::getDataParsoid( $range->endElem )->tsr;
		unset( $endDataMw->rangeId );
	}

	/**
	 * Returns the meta type of the element if it exists and matches the type expected by the
	 * current class, null otherwise
	 * @param Element $elem the element to check
	 * @return string|null
	 */
	protected function matchMetaType( Element $elem ): ?string {
		// for this class we're interested in the annotation type
		return WTUtils::matchAnnotationMeta( $elem );
	}

	/**
	 * Removes the inner annotations of nested annotations.
	 * If an annotation eventually supports nesting, we can revisit this by adding a config flag
	 * on annotations to indicate whether they can be nested or not, and deal with that
	 * conditionally in this method.
	 *
	 * @param Node $node
	 * @param array &$openAnnotations
	 */
	private function removeNestedRanges( Node $node, array &$openAnnotations ) {
		$nextSibling = $node->nextSibling;
		if ( WTUtils::isAnnotationStartMarkerMeta( $node ) ) {
			'@phan-var Element $node'; /** @var Element $node */
			$type = WTUtils::extractAnnotationType( $node );
			if ( $type ) {
				if ( !array_key_exists( $type, $openAnnotations ) ) {
					$openAnnotations[$type] = 0;
				}

				if ( $openAnnotations[$type] > 0 ) {
					DOMDataUtils::getDataParsoid( $node )->misnested = true;
					DOMCompat::getParentElement( $node )->removeChild( $node );
					$this->env->log( 'warn/wt2html', 'Nested annotation start tag removed' );
				}
				$openAnnotations[$type]++;
			}
		} elseif ( WTUtils::isAnnotationEndMarkerMeta( $node ) ) {
			'@phan-var Element $node'; /** @var Element $node */
			$type = WTUtils::extractAnnotationType( $node );
			if ( $type && array_key_exists( $type, $openAnnotations ) ) {
				if ( $openAnnotations[$type] > 1 ) {
					DOMDataUtils::getDataParsoid( $node )->misnested = true;
					DOMCompat::getParentElement( $node )->removeChild( $node );
					$this->env->log( 'warn/wt2html', 'Nested annotation end tag removed' );
				}
				$openAnnotations[$type]--;
			}
		}

		if ( $node instanceof Element && $node->hasChildNodes() ) {
			$this->removeNestedRanges( $node->firstChild, $openAnnotations );
		}
		if ( $nextSibling !== null ) {
			$this->removeNestedRanges( $nextSibling, $openAnnotations );
		}
	}

	/**
	 * Returns the range ID of a node - in the case of annotations, the "rangeId" property
	 * of its "data-mw" attribute.
	 * @param Element $node
	 * @return string
	 */
	protected function getRangeId( Element $node ): string {
		return DOMDataUtils::getDataMw( $node )->rangeId ?? '';
	}

	/**
	 * @inheritDoc
	 */
	protected function updateDSRForFirstRangeNode( Element $target, Element $source ): void {
		// nop
	}

	/**
	 * @param Node $root
	 */
	public function execute( Node $root ): void {
		$this->wrapAnnotationsInTree( $root );
		$openRanges = [];
		$this->removeNestedRanges( $root, $openRanges );
	}
}
