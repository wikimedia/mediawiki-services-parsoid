<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Tokens;

use Wikimedia\Assert\Assert;
use Wikimedia\JsonCodec\Hint;
use Wikimedia\JsonCodec\JsonCodecable;
use Wikimedia\JsonCodec\JsonCodecableTrait;
use Wikimedia\Parsoid\Core\Source;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\NodeData\DataMw;
use Wikimedia\Parsoid\NodeData\DataParsoid;
use Wikimedia\Parsoid\Utils\CompatJsonCodec;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\Utils;

/**
 * Catch-all class for all token types.
 */
abstract class Token implements JsonCodecable, \JsonSerializable {
	use JsonCodecableTrait;

	public DataParsoid $dataParsoid;
	public ?DataMw $dataMw = null;

	/** @var ?array<KV> */
	public ?array $attribs = null;

	protected function __construct(
		?DataParsoid $dataParsoid, ?DataMw $dataMw
	) {
		$this->dataParsoid = $dataParsoid ?? new DataParsoid;
		$this->dataMw = $dataMw;
	}

	public function __clone() {
		// Deep clone non-primitive properties
		$this->dataParsoid = clone $this->dataParsoid;
		if ( $this->dataMw !== null ) {
			$this->dataMw = clone $this->dataMw;
		}
		if ( $this->attribs !== null ) {
			$this->attribs = Utils::cloneArray( $this->attribs );
		}
	}

	/**
	 * @inheritDoc
	 */
	#[\ReturnTypeWillChange]
	abstract public function jsonSerialize();

	/** @inheritDoc */
	public function toJsonArray(): array {
		return $this->jsonSerialize();
	}

	/** @inheritDoc */
	public static function jsonClassHintFor( string $keyName ) {
		return match ( $keyName ) {
			'dataParsoid' => DOMDataUtils::getCodecHints()['data-parsoid'],
			'dataMw' => DOMDataUtils::getCodecHints()['data-mw'],
			'attribs' => Hint::build( KV::class, Hint::LIST ),
			'nestedTokens' => new Hint( self::hint(), Hint::LIST ),
			default => null
		};
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ) {
		$type = $json['type'] ?? '\\';
		Assert::invariant( !str_contains( $type, '\\' ), 'Bad type' );
		$classParts = explode( '\\', self::class );
		array_pop( $classParts );
		$type = implode( '\\', [ ...$classParts, $type ] );
		Assert::invariant( $type !== self::class, 'Bad type' );
		return $type::newFromJsonArray( $json );
	}

	public static function hint(): Hint {
		return Hint::build( self::class, Hint::INHERITED );
	}

	/**
	 * Returns a string key for this token
	 * @return string
	 */
	public function getType(): string {
		$classParts = explode( '\\', get_class( $this ) );
		return end( $classParts );
	}

	/**
	 * Generic set attribute method.
	 *
	 * @param string $name
	 *    Always a string when used this way.
	 *    The more complex form (where the key is a non-string) are found when
	 *    KV objects are constructed in the tokenizer.
	 * @param string|Token|array<Token|string> $value
	 * @param ?KVSourceRange $srcOffsets
	 */
	public function addAttribute(
		string $name, $value, ?KVSourceRange $srcOffsets = null
	): void {
		$this->attribs[] = new KV( $name, $value, $srcOffsets );
	}

	/**
	 * Generic set attribute method with support for change detection.
	 * Set a value and preserve the original wikitext that produced it.
	 *
	 * @param string $name
	 * @param string|Token|array<Token|string> $value
	 * @param mixed $origValue
	 */
	public function addNormalizedAttribute( string $name, $value, $origValue ): void {
		$this->addAttribute( $name, $value );
		$this->setShadowInfo( $name, $value, $origValue );
	}

	/**
	 * Generic attribute accessor.
	 *
	 * @param string $name
	 * @return string|Token|array<Token|string>|KV[]|null
	 */
	public function getAttributeV( string $name ) {
		return KV::lookup( $this->attribs, $name );
	}

	/**
	 * Generic attribute accessor.
	 *
	 * @param string $name
	 * @return KV|null
	 */
	public function getAttributeKV( string $name ) {
		return KV::lookupKV( $this->attribs, $name );
	}

	/**
	 * Generic attribute accessor.
	 *
	 * @param string $name
	 * @return bool
	 */
	public function hasAttribute( string $name ): bool {
		return $this->getAttributeKV( $name ) !== null;
	}

	/**
	 * Set an unshadowed attribute.
	 *
	 * @param string $name
	 * @param string|Token|array<Token|string> $value
	 */
	public function setAttribute( string $name, $value ): void {
		// First look for the attribute and change the last match if found.
		for ( $i = count( $this->attribs ) - 1; $i >= 0; $i-- ) {
			$kv = $this->attribs[$i];
			$k = $kv->k;
			if ( is_string( $k ) && mb_strtolower( $k ) === $name ) {
				$kv->v = $value;
				$this->attribs[$i] = $kv;
				return;
			}
		}
		// Nothing found, just add the attribute
		$this->addAttribute( $name, $value );
	}

	/**
	 * Store the original value of an attribute in a token's dataParsoid.
	 *
	 * @param string $name
	 * @param mixed $value
	 * @param mixed $origValue
	 */
	public function setShadowInfo( string $name, $value, $origValue ): void {
		// Don't shadow if value is the same or the orig is null
		if ( $value !== $origValue && $origValue !== null ) {
			$this->dataParsoid->a ??= [];
			$this->dataParsoid->a[$name] = $value;
			$this->dataParsoid->sa ??= [];
			$this->dataParsoid->sa[$name] = $origValue;
		}
	}

	/**
	 * Attribute info accessor for the wikitext serializer. Performs change
	 * detection and uses unnormalized attribute values if set. Expects the
	 * context to be set to a token.
	 *
	 * @param string $name
	 * @return array{value: string|Token|array<Token|KV|string>, modified: bool, fromsrc: bool}
	 *  Information about the shadow info attached to this attribute:
	 *   - value: (string|Token|array<Token|KV|string>)
	 *     When modified is false and fromsrc is true, this is always a string.
	 *   - modified: (bool)
	 *   - fromsrc: (bool)
	 */
	public function getAttributeShadowInfo( string $name ): array {
		$curVal = $this->getAttributeV( $name );

		// Not the case, continue regular round-trip information.
		if ( !property_exists( $this->dataParsoid, 'a' ) ||
			!array_key_exists( $name, $this->dataParsoid->a )
		) {
			return [
				"value" => $curVal,
				// Mark as modified if a new element
				"modified" => $this->dataParsoid->isModified(),
				"fromsrc" => false
			];
		} elseif ( $this->dataParsoid->a[$name] !== $curVal ) {
			return [
				"value" => $curVal,
				"modified" => true,
				"fromsrc" => false
			];
		} elseif ( !property_exists( $this->dataParsoid, 'sa' ) ||
			!array_key_exists( $name, $this->dataParsoid->sa )
		) {
			return [
				"value" => $curVal,
				"modified" => false,
				"fromsrc" => false
			];
		} else {
			return [
				"value" => $this->dataParsoid->sa[$name],
				"modified" => false,
				"fromsrc" => true
			];
		}
	}

	/**
	 * Completely remove all attributes with this name.
	 *
	 * @param string $name
	 */
	public function removeAttribute( string $name ): void {
		foreach ( $this->attribs as $i => $kv ) {
			if ( is_string( $kv->k ) && mb_strtolower( $kv->k ) === $name ) {
				unset( $this->attribs[$i] );
			}
		}
		$this->attribs = array_values( $this->attribs );
	}

	/**
	 * Add a space-separated property value.
	 * These are Parsoid-added attributes, not something present in source.
	 * So, only a regular ASCII space characters will be used here.
	 *
	 * @param string $name The attribute name
	 * @param string $value The value to add to the attribute
	 */
	public function addSpaceSeparatedAttribute( string $name, string $value ): void {
		$curVal = $this->getAttributeKV( $name );
		if ( $curVal !== null ) {
			if ( in_array( $value, explode( ' ', $curVal->v ), true ) ) {
				// value is already included, nothing to do.
				return;
			}

			// Value was not yet included in the existing attribute, just add
			// it separated with a space
			$this->setAttribute( $curVal->k, $curVal->v . ' ' . $value );
		} else {
			// the attribute did not exist at all, just add it
			$this->addAttribute( $name, $value );
		}
	}

	/**
	 * Get the wikitext source of a token.
	 *
	 * @param Source ...$source Optional Source, for context.
	 * @return string
	 */
	public function getWTSource( Source ...$source ): string {
		$tsr = $this->dataParsoid->tsr ?? null;
		if ( !( $tsr instanceof SourceRange ) ) {
			throw new InvalidTokenException( 'Expected token to have tsr info.' );
		}
		Assert::invariant( $tsr->end >= $tsr->start, 'Bad TSR' );
		return $tsr->substr( ...$source );
	}

	/**
	 * Get a token from some PHP structure. Used by the PHPUnit tests.
	 *
	 * @param KV|Token|array|string|int|float|bool|null $input
	 * @return Token|string|int|float|bool|null|array<Token|string|int|float|bool|null>
	 */
	public static function getToken( $input ) {
		if ( !$input ) {
			return $input;
		}
		$codec = new CompatJsonCodec();
		return $codec->newFromJsonArray( $input, self::hint() );
	}

	public function fetchExpandedAttrValue( string $key ): ?DocumentFragment {
		if ( preg_match(
			'/mw:ExpandedAttrs/', $this->getAttributeV( 'typeof' ) ?? ''
		) ) {
			$dmw = $this->dataMw;
			if ( !isset( $dmw->attribs ) ) {
				return null;
			}
			foreach ( $dmw->attribs as $attr ) {
				if ( $attr->getKeyString() === $key ) {
					return $attr->value['html'] ?? null;
				}
			}
		}
		return null;
	}

}
