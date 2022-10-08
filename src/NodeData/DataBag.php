<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\NodeData;

use stdClass;
use Wikimedia\Parsoid\Utils\PHPUtils;

class DataBag {
	/**
	 * @var NodeData[] A map of node data-object-id ids to data objects.
	 * This map is used during DOM processing to avoid having to repeatedly
	 * json-parse/json-serialize data-parsoid and data-mw attributes.
	 * This map is initialized when a DOM is created/parsed/refreshed.
	 */
	private $dataObject;

	/** @var int An id counter for this document used for the dataObject map */
	private $docId;

	/** @var stdClass the page bundle object into which all data-parsoid and data-mw
	 * attributes will be extracted to for pagebundle API requests.
	 */
	private $pageBundle;

	/**
	 * FIXME: Figure out a decent interface for updating these depths
	 * without needing to import the various util files.
	 *
	 * Map of start/end meta tag tree depths keyed by about id
	 */
	public array $transclusionMetaTagDepthMap = [];

	public function __construct() {
		$this->dataObject = [];
		$this->docId = 0;
		$this->pageBundle = (object)[
			"parsoid" => PHPUtils::arrayToObject( [ "counter" => -1, "ids" => [] ] ),
			"mw" => PHPUtils::arrayToObject( [ "ids" => [] ] )
		];
	}

	/**
	 * Return this document's pagebundle object
	 * @return stdClass
	 */
	public function getPageBundle(): stdClass {
		return $this->pageBundle;
	}

	/**
	 * Get the data object for the node with data-object-id 'docId'.
	 * This will return null if a non-existent docId is provided.
	 *
	 * @param int $docId
	 * @return NodeData|null
	 */
	public function getObject( int $docId ): ?NodeData {
		return $this->dataObject[$docId] ?? null;
	}

	/**
	 * Stash the data and return an id for retrieving it later
	 * @param NodeData $data
	 * @return int
	 */
	public function stashObject( NodeData $data ): int {
		$docId = $this->docId++;
		$this->dataObject[$docId] = $data;
		return $docId;
	}
}
