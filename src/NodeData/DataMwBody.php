<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\NodeData;

use Wikimedia\JsonCodec\JsonCodecable;
use Wikimedia\JsonCodec\JsonCodecInterface;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\JsonCodecableWithCodecTrait;

/**
 * Information about the body of an extension tag.
 */
class DataMwBody implements JsonCodecable {
	use JsonCodecableWithCodecTrait;

	/**
	 * The original source string for this extension tag.
	 */
	public ?string $extsrc;

	/**
	 * Embedded HTML for the contents of this tag.
	 */
	public ?DocumentFragment $html;

	/**
	 * Used by the Cite extension.
	 */
	public ?string $id;

	public function __construct( ?string $extsrc = null, ?DocumentFragment $html = null, ?string $id = null ) {
		$this->extsrc = $extsrc;
		$this->html = $html;
		$this->id = $id;
	}

	/**
	 * Transitional helper method to initialize a new value appropriate for DataMw::$body.
	 * @deprecated
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
	 * @deprecated
	 */
	public function setHtml( ParsoidExtensionApi $extApi, DocumentFragment $df ): void {
		$this->html = $df;
	}

	/**
	 * Transitional helper method to get the html property as a
	 * DocumentFragment.
	 * @deprecated
	 */
	public function getHtml( ParsoidExtensionApi $extApi ): DocumentFragment {
		return $this->html;
	}

	public function hasHtml(): bool {
		return $this->html !== null;
	}

	public function __clone() {
		if ( $this->html !== null ) {
			// Deep clone DocumentFragments
			$this->html = DOMDataUtils::cloneDocumentFragment( $this->html );
		}
	}

	/** @inheritDoc */
	public static function jsonClassHintFor( string $keyname ) {
		// 'html' is not hinted as DocumentFragment because we manually
		// encode/decode it for MW Dom Spec 2.8.0 compat.
		return null;
	}

	/** @inheritDoc */
	public function toJsonArray( JsonCodecInterface $codec ): array {
		$result = [];
		if ( $this->extsrc !== null ) {
			$result['extsrc'] = $this->extsrc;
		}
		if ( $this->id !== null ) {
			$result['id'] = $this->id;
		}
		if ( $this->html !== null ) {
			$result['html'] = self::encodeDocumentFragment( $codec, $this->html );
		}
		return $result;
	}

	/** @inheritDoc */
	public static function newFromJsonArray( JsonCodecInterface $codec, array $json ): DataMwBody {
		$html = isset( $json['html'] ) ?
			self::decodeDocumentFragment( $codec, $json['html'] ) : null;
		return new DataMwBody( $json['extsrc'] ?? null, $html, $json['id'] ?? null );
	}
}
