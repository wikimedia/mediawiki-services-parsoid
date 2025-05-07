<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Tokens;

/**
 * XMLish tag
 */
abstract class XMLTagTk extends Token {
	/** Name of the tag */
	protected string $name;

	public function __clone() {
		parent::__clone();
		// No new non-primitive properties to clone.
	}

	public function getName(): string {
		return $this->name;
	}

	/**
	 * @inheritDoc
	 */
	public function jsonSerialize(): array {
		$ret = [
			'type' => $this->getType(),
			'name' => $this->name,
			'attribs' => $this->attribs,
			'dataParsoid' => $this->dataParsoid,
		];
		if ( $this->dataMw !== null ) {
			$ret['dataMw'] = $this->dataMw;
		}
		return $ret;
	}
}
