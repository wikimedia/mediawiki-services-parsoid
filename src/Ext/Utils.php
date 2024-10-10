<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Ext;

use Wikimedia\Parsoid\Config\SiteConfig;
use Wikimedia\Parsoid\Utils\Utils as U;

/**
 * This class provides sundry helpers needed by extensions.
 */
class Utils {
	/**
	 * Entity-escape anything that would decode to a valid wikitext entity.
	 *
	 * Note that HTML5 allows certain "semicolon-less" entities, like
	 * `&para`; these aren't allowed in wikitext and won't be escaped
	 * by this function.
	 *
	 * @param string $text
	 * @return string
	 */
	public static function escapeWtEntities( string $text ): string {
		return U::escapeWtEntities( $text );
	}

	/**
	 * Decode HTML5 entities in wikitext.
	 *
	 * NOTE that wikitext only allows semicolon-terminated entities, while
	 * HTML allows a number of "legacy" entities to be decoded without
	 * a terminating semicolon.  This function deliberately does not
	 * decode these HTML-only entity forms.
	 *
	 * @param string $text
	 * @return string
	 */
	public static function decodeWtEntities( string $text ): string {
		return U::decodeWtEntities( $text );
	}

	/**
	 * Parse media dimensions
	 *
	 * @param SiteConfig $siteConfig
	 * @param string $str media dimension string to parse
	 * @param bool $onlyOne If set, returns null if multiple dimenstions are present
	 * @param bool $localized Defaults to false; set to true if the $str
	 *   has already been matched against `img_width` to localize the `px`
	 *   suffix.
	 * @return array{x:int,y?:int}|null
	 */
	public static function parseMediaDimensions(
		SiteConfig $siteConfig, string $str, bool $onlyOne = false,
		bool $localized = false
	): ?array {
		return U::parseMediaDimensions( $siteConfig, $str, $onlyOne, $localized );
	}

	/**
	 * Encode all characters as entity references.  This is done to make
	 * characters safe for wikitext (regardless of whether they are
	 * HTML-safe). Typically only called with single-codepoint strings.
	 * @param string $s
	 * @return string
	 */
	public static function entityEncodeAll( string $s ): string {
		return U::entityEncodeAll( $s );
	}

	/**
	 * Validate media parameters
	 * More generally, this is defined by the media handler in core
	 * @param ?int $num
	 * @return bool
	 */
	public static function validateMediaParam( ?int $num ): bool {
		return U::validateMediaParam( $num );
	}
}
