<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\NodeData;

use Wikimedia\Bcp47Code\Bcp47Code;
use Wikimedia\JsonCodec\JsonCodecable;
use Wikimedia\JsonCodec\JsonCodecableTrait;

class I18nInfo implements JsonCodecable {
	use JsonCodecableTrait;

	public const USER_LANG = "x-user";
	public const PAGE_LANG = "x-page";

	/**
	 * Value for the "lang" parameter. Can be one of USER_LANG or PAGE_LANG, or a fixed language
	 * code (discouraged when USER_LANG or PAGE_LANG could be used instead).
	 */
	public string $lang;

	/**
	 * Key of the message in localization files
	 */
	public string $key;

	/**
	 * Ordered list of parameters for the localized message
	 * @var ?list
	 */
	public ?array $params;

	public function __construct( string $lang, string $key, ?array $params = null ) {
		$this->lang = $lang;
		$this->key = $key;
		$this->params = $params;
	}

	public function __clone() {
		// Parameters should generally be immutable, in which case a clone
		// isn't strictly speaking necessary.  But just in case someone puts
		// a mutable object in here, deep clone the parameter array.
		foreach ( $this->params ?? [] as $key => &$value ) {
			if ( is_object( $value ) ) {
				$value = clone $value;
			}
		}
	}

	/**
	 * Creates internationalization information for a string or attribute value in the user
	 * interface language.
	 * @param string $key
	 * @param array|null $params
	 * @return I18nInfo
	 */
	public static function createInterfaceI18n( string $key, ?array $params ): I18nInfo {
		return new I18nInfo( self::USER_LANG, $key, $params );
	}

	/**
	 * Creates internationalization information for a string or attribute value in the page
	 * content language.
	 * @param string $key
	 * @param array|null $params
	 * @return I18nInfo
	 */
	public static function createPageContentI18n( string $key, ?array $params ): I18nInfo {
		return new I18nInfo( self::PAGE_LANG, $key, $params );
	}

	/**
	 * Creates internationalization information for a string or attribute value in an arbitrary
	 * language.
	 * The use of this method is discouraged; use ::createPageContentI18n(...) and
	 * ::createInterfaceI18n(...) where possible rather than, respectively,
	 * ::createLangI18n($wgContLang, ...) and ::createLangI18n($wgLang, ...).
	 * @param Bcp47Code $lang
	 * @param string $key
	 * @param array|null $params
	 * @return I18nInfo
	 */
	public static function createLangI18n( Bcp47Code $lang, string $key, ?array $params ): I18nInfo {
		return new I18nInfo( $lang->toBcp47Code(), $key, $params );
	}

	// Rich attribute serialization support.

	/** @inheritDoc */
	public function toJsonArray(): array {
		$json = [
			'lang' => $this->lang,
			'key' => $this->key,
		];
		// Save some space when there are no params
		if ( $this->params !== null ) {
			$json['params'] = $this->params;
		}
		return $json;
	}

	/** @inheritDoc */
	public static function newFromJsonArray( array $json ) {
		return new I18nInfo( $json['lang'], $json['key'], $json['params'] ?? null );
	}
}
