<?php
declare( strict_types = 1 );

namespace Parsoid\Tokens;

use stdClass;

/**
 * Newline token.
 */
class NlTk extends Token {
	/** @var stdClass Data attributes for this token
	 * TODO: Expand on this.
	 */
	public $dataAttribs;

	/**
	 * @param SourceOffset|null $tsr
	 *    TSR ("tag source range") represents the (start, end) wikitext
	 *    offsets for a token (in this case, the newline) in Unicode char units
	 * @param stdClass|null $dataAttribs
	 */
	public function __construct( ?SourceOffset $tsr, stdClass $dataAttribs = null ) {
		if ( $dataAttribs ) {
			$this->dataAttribs = $dataAttribs;
		} elseif ( $tsr ) {
			$this->dataAttribs = (object)[ "tsr" => $tsr ];
		}
	}

	/**
	 * @inheritDoc
	 */
	public function jsonSerialize(): array {
		return [
			'type' => $this->getType(),
			'dataAttribs' => $this->dataAttribs
		];
	}
}
