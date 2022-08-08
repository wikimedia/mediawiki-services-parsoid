<?php

namespace Test\Parsoid\Utils;

use Wikimedia\JsonCodec\JsonCodecableTrait;
use Wikimedia\Parsoid\Utils\RichCodecable;

/**
 * Test helper for rich attribute support.
 */
class SampleRichData implements RichCodecable {
	use JsonCodecableTrait;

	/**
	 * Simple property.
	 * @var int|string
	 */
	public $foo;

	/**
	 * Simple constructor.
	 * @param int|string|null $foo
	 */
	public function __construct( $foo = null ) {
		$this->foo = $foo;
	}

	/**
	 * This provides an alternate constructor for a default rich attribute.
	 *
	 * @return SampleRichData A default value for this rich attribute type
	 */
	public static function defaultValue(): SampleRichData {
		return new SampleRichData( 'default' );
	}

	/**
	 * This provides a "flattened" form of the object, for attributes
	 * with HTML semantics.
	 * @return string
	 */
	public function flatten(): string {
		return "flattened!";
	}

	public static function hint(): string {
		return self::class;
	}

	/** @inheritDoc */
	public function toJsonArray(): array {
		// Rename 'foo' field to 'bar' just to verify that custom serialization
		// works.
		return [ 'bar' => $this->foo ];
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ) {
		// Note that ::toJsonArray renamed the 'foo' field to 'bar'
		return new SampleRichData( $json['bar'] );
	}
}
