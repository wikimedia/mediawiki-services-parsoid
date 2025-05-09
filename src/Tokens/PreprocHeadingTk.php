<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Tokens;

/**
 * Represents a potential heading from the preprocessor.
 * These aren't guaranteed to be actual headings in the final output,
 * but they are tokenized and so prevent splits on | or = for
 * arguments.  They are also given indices.
 */
class PreprocHeadingTk extends PreprocTk {
	public const TRAILING_WS_ATTR = 'mw:trailingWS';

	public function __construct(
		SourceRange $tsr,
		KV $contents,
		int $count,
		/** Trailing whitespace and comments */
		KV $trailingWS,
		/** Heading index assigned by the preprocessor */
		public int $headingIndex,
	) {
		parent::__construct(
			PreprocType::HEADING,
			$tsr,
			$contents,
			$count,
		);
		$trailingWS->k = self::TRAILING_WS_ATTR;
		$this->attribs[] = $trailingWS;
	}

	public function getTrailingWSKV(): KV {
		return $this->getAttributeKV( self::TRAILING_WS_ATTR );
	}

	public function __clone() {
		parent::__clone();
		// No new non-primitive properties to clone.
	}

	/** @inheritDoc */
	#[\ReturnTypeWillChange]
	public function jsonSerialize() {
		return [
			'type' => $this->getType(),
			'count' => $this->count,
			'attribs' => [ $this->getContentsKV(), $this->getTrailingWSKV() ],
			'dataParsoid' => $this->dataParsoid,
			'headingIndex' => $this->headingIndex,
		];
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ) {
		return new self(
			$json['dataParsoid']->tsr,
			$json['attribs'][0],
			$json['count'],
			$json['attribs'][1],
			$json['headingIndex'],
		);
	}

	/** @inheritDoc */
	protected function printInternal( array &$result, string $prefix, bool $pretty ): void {
		parent::printInternal( $result, $prefix, $pretty );
		if ( $pretty ) {
			$prefix .= '|';
		}
		$trail = $this->getTrailingWSKV();
		$this->printContentsInternal( $result, $trail->v, $prefix, $pretty );
	}

}
