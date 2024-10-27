<?php

namespace Test\Parsoid\Utils;

use Wikimedia\JsonCodec\JsonCodecable;
use Wikimedia\JsonCodec\JsonCodecableTrait;

/**
 * Test helper for rich attribute support.
 */
class SampleNestedRichData implements JsonCodecable {
	use JsonCodecableTrait;

	/** Simple property. */
	public SampleRichData $foo;

	/**
	 * Simple constructor.
	 *
	 * @param SampleRichData|null $foo
	 */
	public function __construct( ?SampleRichData $foo = null ) {
		$this->foo = $foo;
	}

	/** @inheritDoc */
	public function toJsonArray(): array {
		// Rename 'foo' field to 'rich' just to verify that custom serialization
		// works.
		return [ 'rich' => $this->foo ];
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ) {
		// Note that ::toJsonArray renamed the 'foo' field to 'rich'
		return new SampleNestedRichData( $json['rich'] );
	}

	/** @inheritDoc */
	public static function jsonClassHintFor( string $keyName ) {
		if ( $keyName === 'rich' ) {
			// Hint that the 'rich' field is of type SampleRichData
			return SampleRichData::hint();
		}
		return null;
	}
}
