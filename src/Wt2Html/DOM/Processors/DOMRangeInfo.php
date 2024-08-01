<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\DOM\Processors;

use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\DOM\Node;

class DOMRangeInfo {
	public string $id;
	public int $startOffset;

	/**
	 * $startElem, $endElem are the start/end meta tags for a transclusion
	 * $start, $end are the start/end DOM nodes after the range is
	 * expanded, merged with other ranges, etc. In the simple cases, they will
	 * be identical to $startElem, $endElem.
	 */
	public Element $startElem;
	public Element $endElem;
	public ?Node $start;
	public ?Node $end;

	/**
	 * In foster-parenting situations, the end-meta tag can show up before the
	 * start-meta.  We record this info for later analysis.
	 */
	public bool $flipped = false;

	/**
	 * A range is marked as extended when it is found to overlap with another
	 * range during findTopLevelNonOverlappingRanges.
	 */
	public bool $extendedByOverlapMerge = false;

	public function __construct(
		string $id, int $startOffset, Element $startMeta, Element $endMeta
	) {
		$this->id = $id;
		$this->startOffset = $startOffset;
		$this->startElem = $startMeta;
		$this->endElem = $endMeta;
	}
}
