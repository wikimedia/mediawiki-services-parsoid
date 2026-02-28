<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\NodeData;

use Wikimedia\Parsoid\Core\BasePageBundle;
use Wikimedia\Parsoid\Utils\CounterType;

class DataBag {
	/**
	 * @var NodeData[] A map of node data-object-id ids to data objects.
	 * This map is used during DOM processing to avoid having to repeatedly
	 * json-parse/json-serialize data-parsoid and data-mw attributes.
	 * This map is initialized when a DOM is created/parsed/refreshed.
	 */
	private array $dataObject = [];

	/** An id counter for this document used for the dataObject map */
	private int $nodeId = 0;

	/** An id counter for this document used for about IDs. */
	private int $aboutId = 1;

	/** An id counter for this document used for annotation IDs. */
	private int $annotationId = 0;

	/**
	 * This is the input page bundle for an input doc available in pagebundle form.
	 * It is read-only and hence does not need to be deep-cloned. During eager
	 * loading of the doc's data-* attributes, this is useless after loading completes.
	 * But, during lazy loading, unloaded data will be transferred over to the
	 * output pagebundle during serialization, and so this pagebundle might be active
	 * and used till the very end of the request.
	 */
	public ?BasePageBundle $inputPageBundle = null;

	/**
	 * Should every Parsoid-generated node be serialized with a data-parsoid attribute?
	 * This property is set per-transformation (whether wt2html, html2wt, or html2html)
	 * and as such, we record it here in the top-level document's databag.
	 * This is true everywhere except during wt2html transforms and is hence safe
	 * to default to false.
	 */
	public bool $serializeNewEmptyDp = false;

	/**
	 * Track whether or not data attributes have been loaded for this document.
	 * See DOMDataUtils::prepareAndLoadDoc(). This flag might eventually be removed.
	 */
	public bool $loaded = false;

	/**
	 * FIXME: Figure out a decent interface for updating these depths
	 * without needing to import the various util files.
	 *
	 * Map of start/end meta tag tree depths keyed by about id
	 */
	public array $transclusionMetaTagDepthMap = [];

	/**
	 * Get the data object for the node with data-object-id 'nodeId'.
	 * This will return null if a non-existent nodeId is provided.
	 *
	 * @param int $nodeId
	 * @return NodeData|null
	 */
	public function getObject( int $nodeId ): ?NodeData {
		return $this->dataObject[$nodeId] ?? null;
	}

	/**
	 * Stash the data and return an id for retrieving it later
	 */
	public function stashObject( NodeData $data ): int {
		$nodeId = $this->nodeId++;
		$this->dataObject[$nodeId] = $data;
		return $nodeId;
	}

	public function updateCountersFromPageBundle( BasePageBundle $pb ): void {
		if ( $pb->counters !== null ) {
			$this->annotationId = max( $this->annotationId, $pb->counters['annotation'] ?? -1 );
			$this->aboutId = max( $this->aboutId, $pb->counters['transclusion'] ?? -1 );
		}
	}

	public function updateCountersInPageBundle( BasePageBundle $pb ): void {
		$pb->counters['annotation'] = $this->counterValue( CounterType::ANNOTATION_ABOUT );
		$pb->counters['transclusion'] = $this->counterValue( CounterType::TRANSCLUSION_ABOUT );
	}

	public function counterValue( CounterType $type ): int {
		return match ( $type ) {
			CounterType::ANNOTATION_ABOUT => $this->annotationId,
			CounterType::TRANSCLUSION_ABOUT => $this->aboutId,
			// Id counter isn't stored in the DataBag class
			CounterType::NODE_DATA_ID => throw new \LogicException( "Not stored here" )
		};
	}

	public function newAboutId(): string {
		return CounterType::TRANSCLUSION_ABOUT->counterToId( $this->aboutId++ );
	}

	public function seenAboutId( string $id ): void {
		$val = CounterType::TRANSCLUSION_ABOUT->idToCounter( $id );
		if ( $val !== null ) {
			$val = intval( $val );
			if ( $this->aboutId <= $val ) {
				$this->aboutId = $val + 1;
			}
		}
	}

	public function newAnnotationId(): string {
		return CounterType::ANNOTATION_ABOUT->counterToId( $this->annotationId++ );
	}

	public function seenAnnotationId( string $id ): void {
		$val = CounterType::ANNOTATION_ABOUT->idToCounter( $id );
		if ( $val !== null ) {
			$val = intval( $val );
			if ( $this->annotationId <= $val ) {
				$this->annotationId = $val + 1;
			}
		}
	}

	public function __clone() {
		// The only thing which needs to be deep cloned is $dataObject
		foreach ( $this->dataObject as $id => &$nodeData ) {
			$nodeData = clone $nodeData;
		}
	}
}
