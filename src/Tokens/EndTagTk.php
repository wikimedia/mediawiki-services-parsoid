<?php
declare( strict_types = 1 );

namespace Parsoid\Tokens;

use StdClass;

/**
 * Represents an HTML end tag token
 */
class EndTagTk extends Token {
	/** @var string Name of the end tag */
	private $name;

	/** @var array Attributes of this token
	 * This is represented an array of KV objects
	 * TODO: Expand on this.
	 */
	public $attribs = [];

	/** @var StdClass Data attributes for this token
	 * TODO: Expand on this.
	 */
	public $dataAttribs;

	/**
	 * @param string $name
	 * @param KV[] $attribs
	 * @param StdClass|null $dataAttribs
	 */
	public function __construct( string $name, array $attribs = [], StdClass $dataAttribs = null ) {
		$this->name = $name;
		$this->attribs = $attribs;
		$this->dataAttribs = $dataAttribs ?? (object)[];
	}

	/**
	 * @return string
	 */
	public function getName(): string {
		return $this->name;
	}

	/**
	 * @inheritDoc
	 */
	public function jsonSerialize(): array {
		return [
			'type' => $this->getType(),
			'name' => $this->name,
			'attribs' => $this->attribs,
			'dataAttribs' => $this->dataAttribs
		];
	}
}
