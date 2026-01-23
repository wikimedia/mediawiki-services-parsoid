<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\NodeData;

use Wikimedia\JsonCodec\Hint;
use Wikimedia\JsonCodec\JsonCodecInterface;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\JsonCodecableWithCodecTrait;
use Wikimedia\Parsoid\Utils\RichCodecable;
use Wikimedia\Parsoid\Utils\Utils;
use Wikimedia\Parsoid\Wikitext\Consts;

/**
 * data-mw-variant information, used to describe language converter markup.
 */
class DataMwVariant implements RichCodecable {
	use JsonCodecableWithCodecTrait;

	public ?DocumentFragment $disabled = null;

	/** @var list<VariantTwoWay> */
	public ?array $twoway = null;

	/** @var list<VariantOneWay> */
	public ?array $oneway = null;

	public ?VariantFilter $filter = null;

	public ?bool $show = null;

	public ?bool $add = null;

	public ?bool $error = null;

	public ?bool $title = null;

	public ?bool $describe = null;

	public ?bool $remove = null;

	/** Used to mark synthetic spans created by the FST implementation. */
	public ?bool $rt = null;

	public ?DocumentFragment $name = null;

	public function __clone() {
		// Deep clone non-primitive properties

		// 1. Properties which are lists of cloneable objects
		foreach ( [ 'twoway', 'oneway' ] as $prop ) {
			if ( $this->$prop !== null ) {
				$this->$prop = Utils::cloneArray( $this->$prop );
			}
		}

		// 2. Properties which are cloneable objects
		foreach ( [ 'filter' ] as $prop ) {
			if ( $this->$prop !== null ) {
				$this->$prop = clone $this->$prop;
			}
		}
		// 3. Properties which are DocumentFragments
		foreach ( [ 'disabled', 'name' ] as $prop ) {
			if ( $this->$prop instanceof DocumentFragment ) {
				$this->$prop = DOMDataUtils::cloneDocumentFragment( $this->$prop );
			}
		}
	}

	// Rich attribute serialization support.

	/**
	 * Return a default value for an unset data-mw-variant attribute.
	 * @return DataMwVariant
	 */
	public static function defaultValue(): DataMwVariant {
		return new DataMwVariant;
	}

	/** @return Hint<DataMwVariant> */
	public static function hint(): Hint {
		static $hint = null;
		if ( $hint === null ) {
			$hint = Hint::build( self::class, Hint::ALLOW_OBJECT );
		}
		return $hint;
	}

	/** @inheritDoc */
	public function flatten(): ?string {
		return null;
	}

	/** @inheritDoc */
	public static function jsonClassHintFor( string $keyName ) {
		static $hints = null;
		if ( $hints === null ) {
			$hints = [
				'twoway' => Hint::build( VariantTwoWay::class, Hint::LIST ),
				'oneway' => Hint::build( VariantOneWay::class, Hint::LIST ),
				'filter' => VariantFilter::class,
				// 'name' and 'disabled' aren't hinted because they are
				// manually encoded/decoded
			];
		}
		return $hints[$keyName] ?? null;
	}

	/** @inheritDoc */
	public function toJsonArray( JsonCodecInterface $codec ): array {
		// To avoid too much data-mw bloat, only the top level keys in
		// data-mw-variant are "human readable".  Nested keys are single-letter:
		// `l` for `language`, `t` for `text` or `to`, `f` for `from`.
		$json = [];
		// Flags have to go first, because certain of them need to be
		// overwritten (ie, 'disabled' and 'name')
		foreach ( Consts::$LCFlagMap as $name ) {
			if ( $this->$name ?? false ) {
				$json[$name] = true;
			}
		}
		foreach ( [ 'filter', 'oneway', 'twoway', 'rt' ] as $field ) {
			if ( $this->$field !== null ) {
				$json[$field] = $this->$field;
			}
		}
		// HTML-valued fields.
		// disabled/name compatibility with MediaWiki DOM Spec 2.8.0
		// See [[mw:Parsoid/MediaWiki DOM spec/Rich Attributes]] Phase 3
		// for discussion about alternate _h/_t marking for DocumentFragments
		foreach ( [ 'disabled', 'name' ] as $field ) {
			if ( $this->$field instanceof DocumentFragment ) {
				$v = self::encodeDocumentFragment( $codec, $this->$field );
				if ( is_string( $v ) ) {
					// legacy field name was 't' (for 'text')
					$json[$field] = [ 't' => $v, ];
				} else {
					$json[$field] = $v;
				}
			}
		}
		// Sort keys, for reproducibility.
		ksort( $json );
		return $json;
	}

	/** @inheritDoc */
	public static function newFromJsonArray( JsonCodecInterface $codec, array $json ): DataMwVariant {
		$dmv = new DataMwVariant();
		foreach ( $json as $k => $v ) {
			if ( $k === 'disabled' || $k === 'name' ) {
				$v = self::decodeDocumentFragment( $codec, $v['t'] ?? $v );
			}
			// Backwards-compatibility: `bidir` => `twoway` ; `unidir` => `oneway`
			if ( $k === 'bidir' ) {
				$k = 'twoway';
			} elseif ( $k === 'unidir' ) {
				$k = 'oneway';
			}
			$dmv->$k = $v;
		}
		return $dmv;
	}
}
