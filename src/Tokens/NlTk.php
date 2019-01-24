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
		if ( $tsr ) {
			$this->dataAttribs = [ "tsr" => $tsr ];
		} elseif ( $dataAttribs ) {
			// PORT-FIXME: This clause doesn't exist on the JS side
			// but is required for transformTests.php code to construct
			// complete tokens from a JSON blob.
			// See https://gerrit.wikimedia.org/r/c/mediawiki/services/parsoid/+/486189/1/src/Tokens/NlTk.php
			// for Brad's suggestions.
			$this->dataAttribs = $dataAttribs;
		}
	}

	/**
	 * @inheritDoc
	 */
	public function jsonSerialize() {
		return [
			'type' => $this->type,
			'dataAttribs' => $this->dataAttribs
		];
	}
}
