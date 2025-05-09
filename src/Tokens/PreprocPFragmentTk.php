<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Tokens;

use Wikimedia\Assert\Assert;
use Wikimedia\Parsoid\Utils\PipelineUtils;

/**
 * Represents "PFragment tokens" from the preprocessor.  These are
 * the Parsoid equivalent of core "strip markers", and represent
 * opaque transcluded content.
 */
class PreprocPFragmentTk extends PreprocTk {

	public function __construct(
		SourceRange $tsr,
		string|KV $contents,
	) {
		parent::__construct(
			PreprocType::PFRAGMENT,
			$tsr,
			$contents instanceof KV ? $contents :
				self::newContentsKV( [ $contents ], $tsr ),
			count: 0,
		);
		$contents = $this->getContents();
		Assert::invariant(
			count( $contents ) === 1 && is_string( $contents[0] ),
			"contents should be a plain string"
		);
		Assert::invariant(
			str_starts_with( $this->getMarker(), PipelineUtils::PARSOID_FRAGMENT_PREFIX ),
			"contents should be a parsoid fragment marker"
		);
	}

	/**
	 * Return the Parsoid fragment marker, which can be passed to (eg)
	 * TokenizerUtils::parsoidFragmentMarkerToTokens()
	 */
	public function getMarker(): string {
		return $this->getContents()[0];
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
			'attribs' => $this->attribs,
			'dataParsoid' => $this->dataParsoid,
		];
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ) {
		return new self(
			$json['dataParsoid']->tsr,
			$json['attribs'][0]
		);
	}

	/** @inheritDoc */
	protected function printInternal( array &$result, string $prefix, bool $pretty ): void {
		if ( $pretty ) {
			$id = substr( $this->getMarker(), strlen( PipelineUtils::PARSOID_FRAGMENT_PREFIX ), -2 );
			$result[] = $prefix . "<Parsoid Fragment $id>";
			return;
		}
		parent::printInternal( $result, $prefix, $pretty );
	}
}
