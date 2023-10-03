<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\NodeData;

use Wikimedia\JsonCodec\Hint;
use Wikimedia\JsonCodec\JsonCodecableTrait;
use Wikimedia\Parsoid\Utils\RichCodecable;

/**
 * data-mw-i18n information, used for internationalization. This data is used to represent the
 * information necessary for later localization of messages (in spans) or element attributes values.
 */
class DataMwI18n implements RichCodecable {
	use JsonCodecableTrait;

	/** @var array<string,I18nInfo> */
	private $i18nInfo = [];

	/**
	 * Get the I18nInfo associated to a span (which will be used to fill in the span content) or
	 * null, if non-existent.
	 * @return I18nInfo|null
	 */
	public function getSpanInfo(): ?I18nInfo {
		return $this->i18nInfo['/'] ?? null;
	}

	/**
	 * Get the I18nInfo that will be used to localize an element attribute value with the name
	 * $name or null, if non-existent.
	 * @param string $name
	 * @return I18nInfo|null
	 */
	public function getAttributeInfo( string $name ): ?I18nInfo {
		return $this->i18nInfo[$name] ?? null;
	}

	/**
	 * Get the name of the localized attributes or an empty array if no localized attributes
	 * @return array
	 */
	public function getAttributeNames(): array {
		$res = [];
		foreach ( $this->i18nInfo as $k => $v ) {
			if ( $k !== '/' ) {
				$res[] = $k;
			}
		}
		return $res;
	}

	/**
	 * Defines the internationalization parameters of a string contained in a span.
	 */
	public function setSpanInfo( I18nInfo $info ) {
		$this->i18nInfo['/'] = $info;
	}

	/**
	 * Defines the internationalization parameters of the $name attribute's value.
	 */
	public function setAttributeInfo( string $name, I18nInfo $info ) {
		$this->i18nInfo[$name] = $info;
	}

	// Rich attribute serialization support.

	/**
	 * Return a default value for an unset data-mw-i18n attribute.
	 * @return DataMwI18n
	 */
	public static function defaultValue(): DataMwI18n {
		return new DataMwI18n;
	}

	public static function hint(): Hint {
		return Hint::build( self::class, Hint::ALLOW_OBJECT );
	}

	/** @inheritDoc */
	public function flatten(): ?string {
		return null;
	}

	/** @inheritDoc */
	public function toJsonArray(): array {
		return $this->i18nInfo;
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ) {
		$i18n = new DataMwI18n();
		foreach ( $json as $k => $v ) {
			$i18n->i18nInfo[$k] = $v;
		}
		return $i18n;
	}

	/** @inheritDoc */
	public static function jsonClassHintFor( string $keyName ): ?string {
		return I18nInfo::class;
	}
}
