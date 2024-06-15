<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Tokens;

use Wikimedia\Parsoid\NodeData\DataMw;
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
	 * @param ?DataParsoid $dataParsoid
	 * @param ?DataMw $dataMw
	 */
	public function __construct(
		?SourceRange $tsr,
		?DataParsoid $dataParsoid = null,
		?DataMw $dataMw = null
	) {
		parent::__construct( $dataParsoid, $dataMw );
		if ( $dataParsoid == null && $tsr !== null ) {
			$this->dataParsoid->tsr = $tsr;
		}
	}

	/**
	 * @inheritDoc
	 */
	public function jsonSerialize(): array {
		return [
			'type' => $this->getType(),
			'dataParsoid' => $this->dataParsoid,
			'dataMw' => $this->dataMw,
		];
	}
}
