<?php

namespace Parsoid\Tokens;

/**
 * Newline token.
 */
class NlTk extends Token {
	protected $type = 'NlTk';

	/** @var array Data attributes for this token
	 * This is represented an associative key-value array
	 * TODO: Expand on this.
	 */
	public $dataAttribs = [];

	/**
	 * @param array|null $tsr
	 *    TSR ("tag source range") represents the (start, end) wikitext
	 *    offsets for a token (in this case, the newline)
	 * @param array $dataAttribs
	 */
	public function __construct( $tsr, array $dataAttribs = [] ) {
		if ( $dataAttribs ) {
			$this->dataAttribs = $dataAttribs;
		} elseif ( $tsr ) {
			$this->dataAttribs = [ "tsr" => $tsr ];
		}
	}

	/**
	 * @inheritDoc
	 */
	public function jsonSerialize() {
		return [
			'type' => $this->type,
			'dataAttribs' => $this->serializedDataAttribs()
		];
	}
}
