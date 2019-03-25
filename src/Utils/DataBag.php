<?php
declare( strict_types = 1 );

namespace Parsoid\Utils;

use stdClass as StdClass;

class DataBag {
	/**
	 * @var array A map of node data-object-id ids to data objects.
	 * This map is used during DOM processing to avoid having to repeatedly
	 * json-parse/json-serialize data-parsoid and data-mw attributes.
	 * This map is initialized when a DOM is created/parsed/refreshed.
	 */
	private $dataObject;

	/** @var int An id counter for this document used for the dataObject map */
	private $docId;

	/** @var StdClass the page bundle object into which all data-parsoid and data-mw
	 * attributes will be extracted to for pagebundle API requests. */
	private $pageBundle;

	public function __construct() {
		$this->dataObject = [];
		$this->docId = 0;
		$this->pageBundle = (object)[
			"parsoid" => (object)[ "counter" => -1, "ids" => [] ],
			"mw" => (object)[ "ids" => [] ]
		];
	}

	/**
	 * Return this document's pagebundle object
	 * @return StdClass
	 */
	public function getPageBundle(): StdClass {
		return $this->pageBundle;
	}

	/**
	 * Get the data object for the node with data-object-id 'docId'.
	 * This will return null if a non-existent docId is provided.
	 *
	 * @param int $docId
	 * @return StdClass|null
	 */
	public function getObject( int $docId ): ?StdClass {
		return $this->dataObject[$docId] ?? null;
	}

	/**
	 * Stash the data and return an id for retrieving it later
	 * @param StdClass $data
	 * @return int
	 */
	public function stashObject( StdClass $data ): int {
		$docId = $this->docId++;
		$this->dataObject[$docId] = $data;
		return $docId;
	}
}
