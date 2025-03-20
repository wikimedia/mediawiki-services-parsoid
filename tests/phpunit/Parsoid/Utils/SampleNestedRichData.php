<?php

namespace Test\Parsoid\Utils;

use Wikimedia\JsonCodec\JsonCodecable;
use Wikimedia\JsonCodec\JsonCodecableTrait;
use Wikimedia\Parsoid\DOM\DocumentFragment;

/**
 * Test helper for rich attribute support.
 */
class SampleNestedRichData implements JsonCodecable {
	use JsonCodecableTrait;

	/** Simple property. */
	public ?SampleRichData $foo;
	/** DocumentFragment property. */
	public ?DocumentFragment $df;

	/**
	 * Simple constructor.
	 *
	 * @param ?SampleRichData $foo
	 * @param ?DocumentFragment $df
	 */
	public function __construct( ?SampleRichData $foo = null, ?DocumentFragment $df = null ) {
		$this->foo = $foo;
		$this->df = $df;
	}

	/** @inheritDoc */
	public function toJsonArray(): array {
		$json = [];
		if ( $this->foo ) {
			// Rename 'foo' field to 'rich' just to verify that custom
			// serialization works.
			$json['rich'] = $this->foo;
		}
		if ( $this->df ) {
			$json['html'] = $this->df;
		}
		return $json;
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ) {
		return new SampleNestedRichData(
			// Note that ::toJsonArray renamed the 'foo' field to 'rich'
			$json['rich'] ?? null,
			// and the 'df' field to 'html'
			$json['html'] ?? null
		);
	}

	/** @inheritDoc */
	public static function jsonClassHintFor( string $keyName ) {
		if ( $keyName === 'rich' ) {
			// Hint that the 'rich' field is of type SampleRichData
			return SampleRichData::hint();
		}
		if ( $keyName === 'html' ) {
			// Hint that the 'html' field is a DocumentFragment
			return DocumentFragment::class;
		}
		return null;
	}
}
