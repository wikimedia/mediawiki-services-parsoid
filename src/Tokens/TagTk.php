<?php
declare( strict_types = 1 );

namespace Parsoid\Tokens;

/**
 * HTML tag token
 */
class TagTk extends Token {
	protected $type = 'TagTk';

	/** @var string Name of the end tag */
	private $name;

	/** @var array Attributes of this token
	 * This is represented an array of KV objects
	 * TODO: Expand on this.
	 */
	public $attribs = [];

	/** @var object Data attributes for this token
	 * TODO: Expand on this.
	 */
	public $dataAttribs;

	/**
	 * @param string $name
	 * @param KV[] $attribs
	 * @param object|null $dataAttribs data-parsoid object
	 */
	public function __construct( string $name, array $attribs = [], $dataAttribs = null ) {
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
	public function jsonSerialize() {
		return [
			'type' => $this->type,
			'name' => $this->name,
			'attribs' => $this->attribs,
			'dataAttribs' => $this->dataAttribs
		];
	}
}
