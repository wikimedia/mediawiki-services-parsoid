<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\NodeData;

use Wikimedia\JsonCodec\JsonCodecable;
use Wikimedia\JsonCodec\JsonCodecableTrait;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;

/**
 * Information about the body of an extension tag.
 */
class DataMwBody implements JsonCodecable {
	use JsonCodecableTrait;

	/**
	 * The original source string for this extension tag.
	 */
	public ?string $extsrc;

	/**
	 * Embedded HTML for the contents of this tag.
	 */
	public ?string $html;

	/**
	 * Used by the Cite extension.
	 */
	public ?string $id;

	public function __construct( ?string $extsrc = null, ?string $html = null, ?string $id = null ) {
		$this->extsrc = $extsrc;
		$this->html = $html;
		$this->id = $id;
	}

	/**
	 * Transitional helper method to initialize a new value appropriate for DataMw::$body.
	 */
	public static function new( array $values ): DataMwBody {
		return new DataMwBody(
			$values['extsrc'] ?? null,
			$values['html'] ?? null,
			$values['id'] ?? null,
		);
	}

	/**
	 * Transitional helper method to set the html property as a
	 * DocumentFragment.
	 */
	public function setHtml( ParsoidExtensionApi $extApi, DocumentFragment $df ): void {
		$this->html = $extApi->domToHtml( $df, true );
	}

	/**
	 * Transitional helper method to get the html property as a
	 * DocumentFragment.
	 */
	public function getHtml( ParsoidExtensionApi $extApi ): DocumentFragment {
		return $extApi->htmlToDom( $this->html );
	}

	public function hasHtml(): bool {
		return $this->html !== null;
	}

	/**
	 * @suppress PhanEmptyPublicMethod
	 */
	public function __clone() {
		// Shallow clone is sufficient.
	}

	public function equals( DataMwBody $other ): bool {
		// Use non-strict equality test, which will compare the properties
		// @phan-suppress-next-line PhanPluginComparisonObjectEqualityNotStrict
		return $this == $other;
	}

	/** @inheritDoc */
	public function toJsonArray(): array {
		$result = [];
		if ( $this->extsrc !== null ) {
			$result['extsrc'] = $this->extsrc;
		}
		if ( $this->id !== null ) {
			$result['id'] = $this->id;
		}
		if ( $this->html !== null ) {
			$result['html'] = $this->html;
		}
		return $result;
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ): DataMwBody {
		return new DataMwBody( $json['extsrc'] ?? null, $json['html'] ?? null, $json['id'] ?? null );
	}
}
