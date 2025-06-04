<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Utils;

use Psr\Log\LoggerInterface;
use Wikimedia\Bcp47Code\Bcp47Code;
use Wikimedia\Bcp47Code\Bcp47CodeValue;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Config\SiteConfig;
use Wikimedia\Parsoid\Core\DomSourceRange;
use Wikimedia\Parsoid\Core\Sanitizer;
use Wikimedia\Parsoid\NodeData\DataMw;
use Wikimedia\Parsoid\NodeData\DataMwBody;
use Wikimedia\Parsoid\NodeData\DataMwExtAttribs;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Wikitext\Consts;

/**
 * This file contains general utilities for token transforms.
 */
class Utils {
	/**
	 * Regular expression fragment for matching wikitext comments.
	 * Meant for inclusion in other regular expressions.
	 */
	// Maintenance note: this is used in /x regexes so all whitespace and # should be escaped
	public const COMMENT_REGEXP_FRAGMENT = '<!--(?>[\s\S]*?-->)';
	/** Regular fragment for matching a wikitext comment */
	public const COMMENT_REGEXP = '/' . self::COMMENT_REGEXP_FRAGMENT . '/';

	public const COMMENT_OR_WS_REGEXP = '/^(\s|' . self::COMMENT_REGEXP_FRAGMENT . ')*$/D';

	/**
	 * Strip Parsoid id prefix from aboutID
	 *
	 * @param string $aboutId aboud ID string
	 * @return string
	 */
	public static function stripParsoidIdPrefix( string $aboutId ): string {
		// 'mwt' is the prefix used for new ids
		return preg_replace( '/^#?mwt/', '', $aboutId );
	}

	/**
	 * Strip PHP namespace from the fully qualified class name
	 * @param string $className
	 * @return string
	 */
	public static function stripNamespace( string $className ): string {
		return preg_replace( '/.*\\\\/', '', $className );
	}

	/**
	 * Check for Parsoid id prefix in an aboutID string
	 *
	 * @param string $aboutId aboud ID string
	 * @return bool
	 */
	public static function isParsoidObjectId( string $aboutId ): bool {
		// 'mwt' is the prefix used for new ids
		return str_starts_with( $aboutId, '#mwt' );
	}

	/**
	 * Determine if the named tag is void (can not have content).
	 *
	 * @param string $name tag name
	 * @return bool
	 */
	public static function isVoidElement( string $name ): bool {
		return isset( Consts::$HTML['VoidTags'][$name] );
	}

	public static function cloneArray( array $arr ): array {
		return array_map(
			static function ( $val ) {
				if ( is_array( $val ) ) {
					return self::cloneArray( $val );
				} elseif ( is_object( $val ) ) {
					return clone $val;
				} else {
					return $val;
				}
			},
			$arr
		);
	}

	/**
	 * Deep clones by default.
	 * @param object|array $obj arrays or plain objects
	 *    Tokens or DOM nodes shouldn't be passed in.
	 *
	 *    CAVEAT: It looks like debugging methods pass in arrays
	 *    that can have DOM nodes. So, for debugging purposes,
	 *    we handle top-level DOM nodes or DOM nodes embedded in arrays
	 *    But, this will miserably fail if an object embeds a DOM node.
	 *
	 * @param bool $deepClone
	 * @param bool $debug
	 * @return object|array
	 * @deprecated Use native PHP cloning and Utils::cloneArray when needed
	 */
	public static function clone( $obj, $deepClone = true, $debug = false ) {
		if ( $debug ) {
			if ( $obj instanceof \DOMNode ) {
				return $obj->cloneNode( $deepClone );
			}
			if ( is_array( $obj ) ) {
				if ( $deepClone ) {
					return array_map(
						static function ( $o ) {
							// @phan-suppress-next-line PhanDeprecatedFunction
							return Utils::clone( $o, true, true );
						},
						$obj
					);
				} else {
					return $obj; // Copy-on-write cloning
				}
			}
		}

		if ( !$deepClone && is_object( $obj ) ) {
			return clone $obj;
		}

		// FIXME, see T161647
		// This will fail if $obj is (or embeds) a DOMNode
		return unserialize( serialize( $obj ) );
	}

	/**
	 * Extract the last *unicode* character of the string.
	 * This might be more than one byte, if the last character
	 * is non-ASCII.
	 * @param string $str
	 * @param ?int $idx The index *after* the character to extract; defaults
	 *   to the length of $str, which will extract the last character in
	 *   $str.
	 * @return string
	 */
	public static function lastUniChar( string $str, ?int $idx = null ): string {
		if ( $idx === null ) {
			$idx = strlen( $str );
		} elseif ( $idx <= 0 || $idx > strlen( $str ) ) {
			return '';
		}
		$c = $str[--$idx];
		while ( ( ord( $c ) & 0xC0 ) === 0x80 ) {
			$c = $str[--$idx] . $c;
		}
		return $c;
	}

	/**
	 * Return true if the first character in $s is a unicode word character.
	 * @param string $s
	 * @return bool
	 */
	public static function isUniWord( string $s ): bool {
		return preg_match( '#^\w#u', $s ) === 1;
	}

	/**
	 * Percent-decode only valid UTF-8 characters, leaving other encoded bytes alone.
	 *
	 * Distinct from `decodeURIComponent` in that certain escapes are not decoded,
	 * matching the behavior of JavaScript's decodeURI().
	 *
	 * @see https://www.ecma-international.org/ecma-262/6.0/#sec-decodeuri-encodeduri
	 * @param string $s URI to be decoded
	 * @return string
	 */
	public static function decodeURI( string $s ): string {
		// Escape the '%' in sequences for the reserved characters, then use decodeURIComponent.
		$s = preg_replace( '/%(?=2[346bcfBCF]|3[abdfABDF]|40)/', '%25', $s );
		return self::decodeURIComponent( $s );
	}

	/**
	 * Percent-decode only valid UTF-8 characters, leaving other encoded bytes alone.
	 *
	 * @param string $s URI to be decoded
	 * @return string
	 */
	public static function decodeURIComponent( string $s ): string {
		// Most of the time we should have valid input
		$ret = rawurldecode( $s );
		if ( mb_check_encoding( $ret, 'UTF-8' ) ) {
			return $ret;
		}

		// Extract each encoded character and decode it individually
		return preg_replace_callback(
			// phpcs:ignore Generic.Files.LineLength.TooLong
			'/%[0-7][0-9A-F]|%[CD][0-9A-F]%[89AB][0-9A-F]|%E[0-9A-F](?:%[89AB][0-9A-F]){2}|%F[0-4](?:%[89AB][0-9A-F]){3}/i',
			static function ( $match ) {
				$ret = rawurldecode( $match[0] );
				return mb_check_encoding( $ret, 'UTF-8' ) ? $ret : $match[0];
			}, $s
		);
	}

	/**
	 * Extract extension source from the token
	 *
	 * @param Token $token token
	 * @return string
	 */
	public static function extractExtBody( Token $token ): string {
		$src = $token->getAttributeV( 'source' );
		$extTagOffsets = $token->dataParsoid->extTagOffsets;
		'@phan-var \Wikimedia\Parsoid\Core\DomSourceRange $extTagOffsets';
		return $extTagOffsets->stripTags( $src );
	}

	/**
	 * Helper function checks numeric values
	 *
	 * @param ?int $n checks parameters for numeric type and value zero or positive
	 * @return bool
	 */
	private static function isValidOffset( ?int $n ): bool {
		return $n !== null && $n >= 0;
	}

	/**
	 * Basic check if a DOM Source Range (DSR) is valid.
	 *
	 * Clarifications about the "basic validity checks":
	 * - Only checks for underflow, not for overflow.
	 * - Does not verify that start <= end
	 * - Does not verify that openWidth + endWidth <= end - start
	 *   (even so, the values might be invalid because of content)
	 * These would be overkill for our purposes. Given how DSR computation
	 * works in thie codebase, the real scenarios we care about are
	 * non-null / non-negative values since that can happen.
	 *
	 * @param ?DomSourceRange $dsr DSR source range values
	 * @param bool $all Also check the widths of the container tag
	 * @return bool
	 */
	public static function isValidDSR(
		?DomSourceRange $dsr, bool $all = false
	): bool {
		return $dsr !== null &&
			self::isValidOffset( $dsr->start ) &&
			self::isValidOffset( $dsr->end ) &&
			( !$all || (
				self::isValidOffset( $dsr->openWidth ) &&
				self::isValidOffset( $dsr->closeWidth )
			  )
			);
	}

	/**
	 * Cannonicalizes a namespace name.
	 *
	 * @param string $name Non-normalized namespace name.
	 * @return string
	 */
	public static function normalizeNamespaceName( string $name ): string {
		return strtr( mb_strtolower( $name ), ' ', '_' );
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
		// Note that HTML5 allows semicolon-less entities which
		// wikitext does not: in wikitext all entities must end in a
		// semicolon.
		// By normalizing before decoding, this routine deliberately
		// does not decode entity references which are invalid in wikitext
		// (mostly because they decode to invalid codepoints).
		return Sanitizer::decodeCharReferences(
			Sanitizer::normalizeCharReferences( $text )
		);
	}

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
		// We just want to encode ampersands that precede valid entities.
		// (And note that semicolon-less entities aren't valid wikitext.)
		return preg_replace_callback( '/&[#0-9a-zA-Z\x80-\xff]+;/', function ( $match ) {
			$m = $match[0];
			$decodedChar = self::decodeWtEntities( $m );
			if ( $decodedChar !== $m ) {
				// Escape the ampersand
				return '&amp;' . substr( $m, 1 );
			} else {
				// Not an entity, just return the string
				return $m;
			}
		}, $text );
	}

	/**
	 * Ensure that the given literal string is safe to parse as wikitext.
	 * See wfEscapeWikiText() in core.
	 */
	public static function escapeWt( string $input ): string {
		static $repl = null, $repl2 = null, $repl3 = null, $repl4 = null;
		if ( $repl === null ) {
			$repl = [
				'"' => '&#34;', '&' => '&#38;', "'" => '&#39;', '<' => '&#60;',
				'=' => '&#61;', '>' => '&#62;', '[' => '&#91;', ']' => '&#93;',
				'{' => '&#123;', '|' => '&#124;', '}' => '&#125;',
				';' => '&#59;', // a token inside language converter brackets
				'!!' => '&#33;!', // a token inside table context
				"\n!" => "\n&#33;", "\r!" => "\r&#33;", // a token inside table context
				"\n#" => "\n&#35;", "\r#" => "\r&#35;",
				"\n*" => "\n&#42;", "\r*" => "\r&#42;",
				"\n:" => "\n&#58;", "\r:" => "\r&#58;",
				"\n " => "\n&#32;", "\r " => "\r&#32;",
				"\n\n" => "\n&#10;", "\r\n" => "&#13;\n",
				"\n\r" => "\n&#13;", "\r\r" => "\r&#13;",
				"\n\t" => "\n&#9;", "\r\t" => "\r&#9;", // "\n\t\n" is treated like "\n\n"
				"\n----" => "\n&#45;---", "\r----" => "\r&#45;---",
				'__' => '_&#95;', '://' => '&#58;//',
				'~~~' => '~~&#126;', // protect from PST, just to be safe(r)
			];

			$magicLinks = [ 'ISBN', 'PMID', 'RFC' ];
			// We have to catch everything "\s" matches in PCRE
			foreach ( $magicLinks as $magic ) {
				$repl["$magic "] = "$magic&#32;";
				$repl["$magic\t"] = "$magic&#9;";
				$repl["$magic\r"] = "$magic&#13;";
				$repl["$magic\n"] = "$magic&#10;";
				$repl["$magic\f"] = "$magic&#12;";
			}
			// Additionally escape the following characters at the beginning of the
			// string, in case they merge to form tokens when spliced into a
			// string.  Tokens like -{ {{ [[ {| etc are already escaped because
			// the second character is escaped above, but the following tokens
			// are handled here: |+ |- __FOO__ ~~~
			$repl3 = [
				'+' => '&#43;', '-' => '&#45;', '_' => '&#95;', '~' => '&#126;',
			];
			// Similarly, protect the following characters at the end of the
			// string, which could turn form the start of `__FOO__` or `~~~~`
			// A trailing newline could also form the unintended start of a
			// paragraph break if it is glued to a newline in the following
			// context.
			$repl4 = [
				'_' => '&#95;', '~' => '&#126;',
				"\n" => "&#10;", "\r" => "&#13;",
				"\t" => "&#9;", // "\n\t\n" is treated like "\n\n"
			];

			// And handle protocols that don't use "://"
			$urlProtocols = [
				'bitcoin:', 'geo:', 'magnet:', 'mailto:', 'matrix:', 'news:',
				'sip:', 'sips:', 'sms:', 'tel:', 'urn:', 'xmpp:',
			];
			$repl2 = [];
			foreach ( $urlProtocols as $prot ) {
				$repl2[] = preg_quote( substr( $prot, 0, -1 ), '/' );
			}
			$repl2 = '/\b(' . implode( '|', $repl2 ) . '):/i';
		}
		// Tell phan that $repl2, $repl3 and $repl4 will also be non-null here
		'@phan-var string $repl2';
		'@phan-var string $repl3';
		'@phan-var string $repl4';
		// This will also stringify input in case it's not a string
		$text = substr( strtr( "\n$input", $repl ), 1 );
		if ( $text === '' ) {
			return $text;
		}
		$first = strtr( $text[0], $repl3 ); // protect first character
		if ( strlen( $text ) > 1 ) {
			$text = $first . substr( $text, 1, -1 ) .
				  strtr( substr( $text, -1 ), $repl4 ); // protect last character
		} else {
			// special case for single-character strings
			$text = strtr( $first, $repl4 ); // protect last character
		}
		$text = preg_replace( $repl2, '$1&#58;', $text );
		return $text;
	}

	/**
	 * Convert special characters to HTML entities
	 *
	 * @param string $s
	 * @return string
	 */
	public static function escapeHtml( string $s ): string {
		// Only encodes five characters: " ' & < >
		$s = htmlspecialchars( $s, ENT_QUOTES | ENT_HTML5 );
		$s = str_replace( "\u{0338}", '&#x338;', $s );
		return $s;
	}

	/**
	 * Encode all characters as entity references.  This is done to make
	 * characters safe for wikitext (regardless of whether they are
	 * HTML-safe). Typically only called with single-codepoint strings.
	 * @param string $s
	 * @return string
	 */
	public static function entityEncodeAll( string $s ): string {
		// This is Unicode aware.
		static $conventions = [
			// We always use at least two characters for the hex code
			'&#x0;' => '&#x00;', '&#x1;' => '&#x01;', '&#x2;' => '&#x02;', '&#x3;' => '&#x03;',
			'&#x4;' => '&#x04;', '&#x5;' => '&#x05;', '&#x6;' => '&#x06;', '&#x7;' => '&#x07;',
			'&#x8;' => '&#x08;', '&#x9;' => '&#x09;', '&#xA;' => '&#x0A;', '&#xB;' => '&#x0B;',
			'&#xC;' => '&#x0C;', '&#xD;' => '&#x0D;', '&#xE;' => '&#x0E;', '&#xF;' => '&#x0F;',
			// By convention we use &nbsp; where possible
			'&#xA0;' => '&nbsp;',
		];

		return strtr( mb_encode_numericentity(
			$s, [ 0, 0x10ffff, 0, ~0 ], 'utf-8', true
		), $conventions );
	}

	/**
	 * Determine whether the protocol of a link is potentially valid. Use the
	 * environment's per-wiki config to do so.
	 *
	 * @param mixed $linkTarget
	 * @param Env $env
	 * @return bool
	 */
	public static function isProtocolValid( $linkTarget, Env $env ): bool {
		$siteConf = $env->getSiteConfig();
		if ( is_string( $linkTarget ) ) {
			return $siteConf->hasValidProtocol( $linkTarget );
		} else {
			return true;
		}
	}

	/**
	 * Get argument information for an extension tag token.
	 *
	 * @param Token $extToken
	 * @return DataMw
	 */
	public static function getExtArgInfo( Token $extToken ): DataMw {
		$name = $extToken->getAttributeV( 'name' );
		$options = $extToken->getAttributeV( 'options' );
		$defaultDataMw = new DataMw( [
			'name' => $name,
			// Back-compat w/ existing DOM spec output: ensure 'extAttribs'
			// exists even if there are no attributes.
			'extAttribs' => new DataMwExtAttribs,
		] );
		foreach ( TokenUtils::kvToHash( $options ) as $name => $value ) {
			// Explicit cast to string is needed here, since a numeric
			// attribute name will get converted to 'int' when it is used
			// as an array key.
			$defaultDataMw->setExtAttrib( (string)$name, $value );
		}
		$extTagOffsets = $extToken->dataParsoid->extTagOffsets;
		if ( $extTagOffsets->closeWidth !== 0 ) {
			// If not self-closing...
			$defaultDataMw->body = new DataMwBody(
				self::extractExtBody( $extToken ),
			);
		}
		return $defaultDataMw;
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
	 * @return ?array{x:int,y?:int,bogusPx:bool}
	 */
	public static function parseMediaDimensions(
		SiteConfig $siteConfig, string $str, bool $onlyOne = false,
		bool $localized = false
	): ?array {
		if ( !$localized ) {
			$getOption = $siteConfig->getMediaPrefixParameterizedAliasMatcher();
			$bits = $getOption( $str );
			$normalizedBit0 = $bits ? mb_strtolower( trim( $bits['k'] ) ) : null;
			if ( $normalizedBit0 === 'img_width' ) {
				$str = $bits['v'];
			}
		}
		$dimensions = null;
		// We support a trailing 'px' here for historical reasons
		// (T15500, T53628, T207032)
		if ( preg_match( '/^(\d*)(?:x(\d+))?\s*(px\s*)?$/D', $str, $match ) ) {
			$dimensions = [ 'x' => null, 'y' => null, 'bogusPx' => false ];
			if ( !empty( $match[1] ) ) {
				$dimensions['x'] = intval( $match[1], 10 );
			}
			if ( !empty( $match[2] ) ) {
				if ( $onlyOne ) {
					return null;
				}
				$dimensions['y'] = intval( $match[2], 10 );
			}
			if ( !empty( $match[3] ) ) {
				$dimensions['bogusPx'] = true;
			}
		}
		return $dimensions;
	}

	/**
	 * Validate media parameters
	 * More generally, this is defined by the media handler in core
	 *
	 * @param ?int $num
	 * @return bool
	 */
	public static function validateMediaParam( ?int $num ): bool {
		return $num !== null && $num > 0;
	}

	/**
	 * Convert BCP-47-compliant language code to MediaWiki-internal code.
	 *
	 * This is a temporary back-compatibility hack; Parsoid should be
	 * using BCP 47 strings or Bcp47Code objects in all its external APIs.
	 * Try to avoid using it, though: there's no guarantee
	 * that this mapping will remain in sync with upstream.
	 *
	 * @param string|Bcp47Code $code BCP-47 language code
	 * @return string MediaWiki-internal language code
	 */
	public static function bcp47ToMwCode( $code ): string {
		// This map is dumped from
		// LanguageCode::NON_STANDARD_LANGUAGE_CODE_MAPPING in core, but
		// with keys and values swapped and BCP-47 codes lowercased:
		//
		//   array_flip(array_map(strtolower,
		//       LanguageCode::NON_STANDARD_LANGUAGE_CODE_MAPPING))
		//
		// Hopefully we will be able to deprecate and remove this from
		// Parsoid quickly enough that keeping it in sync with upstream
		// is not an issue.
		static $MAP = [
			"cbk" => "cbk-zam",
			"de-x-formal" => "de-formal",
			"egl" => "eml",
			"en-x-rtl" => "en-rtl",
			"es-x-formal" => "es-formal",
			"hu-x-formal" => "hu-formal",
			"jv-x-bms" => "map-bms",
			"ro-cyrl-md" => "mo",
			"nrf" => "nrm",
			"nl-x-informal" => "nl-informal",
			"nap-x-tara" => "roa-tara",
			"en-simple" => "simple",
			"sr-cyrl" => "sr-ec",
			"sr-latn" => "sr-el",
			"zh-hans-cn" => "zh-cn",
			"zh-hans-sg" => "zh-sg",
			"zh-hans-my" => "zh-my",
			"zh-hant-tw" => "zh-tw",
			"zh-hant-hk" => "zh-hk",
			"zh-hant-mo" => "zh-mo",
		];
		if ( $code instanceof Bcp47Code ) {
			$code = $code->toBcp47Code();
		}
		$code = strtolower( $code ); // All MW-internal codes are lowercase
		return $MAP[$code] ?? $code;
	}

	/**
	 * Convert MediaWiki-internal language code to a BCP-47-compliant
	 * language code suitable for including in HTML.
	 *
	 * This is a temporary back-compatibility hack, needed for compatibility
	 * when running in standalone mode with MediaWiki Action APIs which expose
	 * internal language codes.  These APIs should eventually be improved
	 * so that they also expose BCP-47 compliant codes, which can then be
	 * used directly by Parsoid without conversion.  But until that day
	 * comes, this function will paper over the differences.
	 *
	 * Note that MediaWiki-internal Language objects implement Bcp47Code,
	 * so we can transition interfaces which currently take a string code
	 * to pass a Language object instead; that will make this method
	 * effectively a no-op and avoid the issue of upstream sync of the
	 * mapping table.
	 *
	 * @param string|Bcp47Code $code MediaWiki-internal language code or object
	 * @param bool $strict If true, this code will log a deprecation message
	 *  or fail if a MediaWiki-internal language code is passed.
	 * @param ?LoggerInterface $warnLogger A deprecation warning will be
	 *   emitted on $warnLogger if $strict is true and a string-valued
	 *   MediaWiki-internal language code is passed; otherwise an exception
	 *   will be thrown.
	 * @return Bcp47Code BCP-47 language code.
	 * @see LanguageCode::bcp47()
	 */
	public static function mwCodeToBcp47(
		$code, bool $strict = false, ?LoggerInterface $warnLogger = null
	): Bcp47Code {
		if ( $code instanceof Bcp47Code ) {
			return $code;
		}
		if ( $strict ) {
			$msg = "Use of string-valued BCP-47 codes is deprecated.";
			if ( defined( 'MW_PHPUNIT_TEST' ) || defined( 'MW_PARSER_TEST' ) ) {
				// Always throw an error if running tests
				throw new \Error( $msg );
			}
			if ( $warnLogger ) {
				$warnLogger->warning( $msg );
			} else {
				// Strict mode requested but no deprecation logger provided
				throw new \Error( $msg );
			}
		}
		// This map is dumped from
		// LanguageCode::getNonstandardLanguageCodeMapping() in core.
		// Hopefully we will be able to deprecate and remove this method
		// from Parsoid quickly enough that keeping it in sync with upstream
		// will not be an issue.
		static $MAP = [
			"als" => "gsw",
			"bat-smg" => "sgs",
			"be-x-old" => "be-tarask",
			"fiu-vro" => "vro",
			"roa-rup" => "rup",
			"zh-classical" => "lzh",
			"zh-min-nan" => "nan",
			"zh-yue" => "yue",
			"cbk-zam" => "cbk",
			"de-formal" => "de-x-formal",
			"eml" => "egl",
			"en-rtl" => "en-x-rtl",
			"es-formal" => "es-x-formal",
			"hu-formal" => "hu-x-formal",
			"map-bms" => "jv-x-bms",
			"mo" => "ro-Cyrl-MD",
			"nrm" => "nrf",
			"nl-informal" => "nl-x-informal",
			"roa-tara" => "nap-x-tara",
			"simple" => "en-simple",
			"sr-ec" => "sr-Cyrl",
			"sr-el" => "sr-Latn",
			"zh-cn" => "zh-Hans-CN",
			"zh-sg" => "zh-Hans-SG",
			"zh-my" => "zh-Hans-MY",
			"zh-tw" => "zh-Hant-TW",
			"zh-hk" => "zh-Hant-HK",
			"zh-mo" => "zh-Hant-MO",
		];
		$code = $MAP[$code] ?? $code;
		// The rest of this code is copied verbatim from LanguageCode::bcp47()
		// in core.
		$codeSegment = explode( '-', $code );
		$codeBCP = [];
		foreach ( $codeSegment as $segNo => $seg ) {
			// when previous segment is x, it is a private segment and should be lc
			if ( $segNo > 0 && strtolower( $codeSegment[( $segNo - 1 )] ) == 'x' ) {
				$codeBCP[$segNo] = strtolower( $seg );
			// ISO 3166 country code
			} elseif ( ( strlen( $seg ) == 2 ) && ( $segNo > 0 ) ) {
				$codeBCP[$segNo] = strtoupper( $seg );
			// ISO 15924 script code
			} elseif ( ( strlen( $seg ) == 4 ) && ( $segNo > 0 ) ) {
				$codeBCP[$segNo] = ucfirst( strtolower( $seg ) );
			// Use lowercase for other cases
			} else {
				$codeBCP[$segNo] = strtolower( $seg );
			}
		}
		return new Bcp47CodeValue( implode( '-', $codeBCP ) );
	}

	/**
	 * BCP 47 codes are case-insensitive, so this helper does a "proper"
	 * comparison of Bcp47Code objects.
	 * @param Bcp47Code $a
	 * @param Bcp47Code $b
	 * @return bool true iff $a and $b represent the same language
	 */
	public static function isBcp47CodeEqual( Bcp47Code $a, Bcp47Code $b ): bool {
		return strcasecmp( $a->toBcp47Code(), $b->toBcp47Code() ) === 0;
	}
}
