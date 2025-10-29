<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Utils;

use Wikimedia\JsonCodec\JsonClassCodec;
use Wikimedia\JsonCodec\JsonCodec;
use Wikimedia\Parsoid\DOM\Document;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\DOM\Element;
use Wikimedia\Parsoid\Wt2Html\XHtmlSerializer;

/**
 * Customized subclass of JsonCodec for serialization of rich attributes.
 */
class DOMDataCodec extends JsonCodec {
	private ?array $fragmentIndex = null;

	public function setOptions( array $options ): array {
		$oldOptions = $this->options;
		$this->options = $options;
		return $oldOptions;
	}

	private static function makeTID( string $base, int $count ): string {
		return $count === 0 ? $base : "$base-$count";
	}

	/**
	 * @return list{string, int}
	 */
	private static function splitTID( string $tid ): array {
		[ $base, $count ] = array_pad( explode( '-', $tid, 2 ), 2, '0' );
		return [ $base, intval( $count ) ];
	}

	private function ensureFragmentIndex(): void {
		if ( $this->fragmentIndex !== null ) {
			return;
		}
		$doc = $this->ownerDoc;
		$this->fragmentIndex = [];
		$templates = DOMCompat::querySelectorAll(
			$doc, 'head > template[data-tid]'
		);
		foreach ( $templates as $t ) {
			$tid = DOMCompat::getAttribute( $t, 'data-tid' );
			[ $base, $count ] = self::splitTID( $tid );
			$this->fragmentIndex[$base][$count] = $t;
		}
	}

	public function setUniqueTID( string $tidBase, Element $template ): string {
		$this->ensureFragmentIndex();
		$max = $this->fragmentIndex[$tidBase]['max'] ?? null;
		if ( $max === null ) {
			$max = max( array_keys( $this->fragmentIndex[$tidBase] ?? [] ) ?: [ -1 ] );
		}
		$count = ++$max;
		// storing max here ensures we're not O(N^2)
		$this->fragmentIndex[$tidBase]['max'] = $count;
		$this->fragmentIndex[$tidBase][$count] = $template;
		$tid = self::makeTID( $tidBase, $count );
		$template->setAttribute( 'data-tid', $tid );
		return $tid;
	}

	public function popTID( string $tid ): Element {
		[ $base, $count ] = self::splitTID( $tid );
		$this->ensureFragmentIndex();
		$t = $this->fragmentIndex[$base][$count];
		$t->parentNode->removeChild( $t );
		unset( $this->fragmentIndex[$base][$count] );
		// reset 'max' because it's not guaranteed to be correct any more
		unset( $this->fragmentIndex[$base]['max'] );
		return $t;
	}

	/**
	 * Return a flattened string representation of this complex object.
	 * @param object $obj
	 * @return ?string
	 */
	public function flatten( $obj ): ?string {
		$codec = $this->codecFor( get_class( $obj ) );
		if ( $codec !== null && method_exists( $codec, 'flatten' ) ) {
			// @phan-suppress-next-line PhanUndeclaredMethod
			return $codec->flatten( $obj );
		}
		if ( method_exists( $obj, 'flatten' ) ) {
			return $obj->flatten();
		}
		return null;
	}

	/**
	 * Return an appropriate default value for objects of the given type.
	 * @template T
	 * @param class-string<T> $className
	 * @return T
	 */
	public function defaultValue( $className ): ?object {
		$codec = $this->codecFor( $className );
		if ( $codec !== null && method_exists( $codec, 'defaultValue' ) ) {
			// @phan-suppress-next-line PhanUndeclaredMethod
			return $codec->defaultValue();
		}
		if ( method_exists( $className, 'defaultValue' ) ) {
			return $className::defaultValue();
		}
		return null;
	}

	/**
	 * Create a new DOMDataCodec.
	 * @param Document $ownerDoc
	 * @param array $options
	 */
	public function __construct( public Document $ownerDoc, public array $options ) {
		parent::__construct();
		// Add codec for DocumentFragment
		$this->addCodecFor( DocumentFragment::class, new class( $this ) implements JsonClassCodec {
			private DOMDataCodec $codec;

			public function __construct( DOMDataCodec $codec ) {
				$this->codec = $codec;
			}

			/**
			 * Flatten the given DocumentFragment into a string.
			 * @param DocumentFragment $df
			 * @return string
			 */
			public function flatten( DocumentFragment $df ): string {
				'@phan-var DocumentFragment $df';
				return $df->textContent;
			}

			/**
			 * Return a default value for a new attribute of this type.
			 * @return DocumentFragment
			 */
			public function defaultValue(): DocumentFragment {
				return $this->codec->ownerDoc->createDocumentFragment();
			}

			/** @inheritDoc */
			public function toJsonArray( $df ): array {
				'@phan-var DocumentFragment $df';
				// Store rich attributes in the document fragment
				// before serializing it; this should share this codec
				// and so the fragment bank numbering won't conflict.
				if ( $this->codec->options['useFragmentBank'] ?? false ) {
					// In theory we could wait to visit-and-store until the
					// ownerDoc is serialized.
					DOMDataUtils::visitAndStoreDataAttribs(
						$df, $this->codec->options
					);
					$t = $this->codec->ownerDoc->createElement( 'template' );
					DOMUtils::migrateChildrenBetweenDocs( $df, DOMCompat::getTemplateElementContent( $t ) );
					DOMCompat::getHead( $this->codec->ownerDoc )->appendChild( $t );
					// Assign a unique ID.
					// Start with a content hash based on text contents; we
					// could do better than this if we needed to, but the basic
					// goal is to make the IDs relatively stable to avoid
					// unnecessary character diffs.
					$hash = hash( 'sha256', DOMCompat::getTemplateElementContent( $t )->textContent, true );
					// Base64 is 6 bits per char, so 6 bytes ought to be 8
					// characters with no padding
					$tidBase = base64_encode( substr( $hash, 0, 6 ) );
					$tid = $this->codec->setUniqueTID( $tidBase, $t );
					return [ '_t' => $tid ];
				} elseif ( $this->codec->options['noSideEffects'] ?? false ) {
					return [ '_h' => XHtmlSerializer::serialize( $df, [
						'innerXML' => true,
						'noSideEffects' => true,
					] )['html'] ];
				} else {
					DOMDataUtils::visitAndStoreDataAttribs(
						$df, $this->codec->options
					);
					return [ '_h' => DOMUtils::getFragmentInnerHTML( $df ) ];
				}
			}

			/** @inheritDoc */
			public function newFromJsonArray( string $className, array $json ) {
				$df = $this->codec->ownerDoc->createDocumentFragment();
				if ( isset( $json['_t'] ) ) {
					// fragment bank representation
					$t = $this->codec->popTID( $json['_t'] );
					DOMUtils::migrateChildrenBetweenDocs( DOMCompat::getTemplateElementContent( $t ), $df );
				} else {
					DOMUtils::setFragmentInnerHTML( $df, $json['_h'] );
				}
				DOMDataUtils::visitAndLoadDataAttribs( $df, $this->codec->options );
				return $df; // @phan-suppress-current-line PhanTypeMismatchReturn
			}

			/** @inheritDoc */
			public function jsonClassHintFor( string $className, string $keyName ): ?string {
				return null;
			}
		} );
	}
}
