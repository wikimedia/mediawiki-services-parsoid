<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Tokens;

use Wikimedia\Parsoid\NodeData\DataParsoid;

/**
 * Newline token.
 */
class NlTk extends Token {
	/**
	 * @param ?SourceRange $tsr
	 *    TSR ("tag source range") represents the (start, end) wikitext
	 *    byte offsets for a token (in this case, the newline) in the
	 *    UTF8-encoded source string
	 * @param ?DataParsoid $dataAttribs
	 */
	public function __construct(
		?SourceRange $tsr, ?DataParsoid $dataAttribs = null
	) {
		if ( $dataAttribs ) {
			$this->dataAttribs = $dataAttribs;
		} elseif ( $tsr ) {
			$this->dataAttribs = new DataParsoid;
			$this->dataAttribs->tsr = $tsr;
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
