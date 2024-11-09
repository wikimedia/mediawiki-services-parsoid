<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\NodeData;

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
	 * @param NodeData $data
	 * @return int
	 */
	public function stashObject( NodeData $data ): int {
		$nodeId = $this->nodeId++;
		$this->dataObject[$nodeId] = $data;
		return $nodeId;
	}
}
