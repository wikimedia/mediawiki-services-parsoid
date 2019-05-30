<?php
declare( strict_types = 1 );

namespace Parsoid\Config;

use Liuggio\StatsdClient\Factory\StatsdDataFactoryInterface;
use Parsoid\Ext\SerialHandler;
use Parsoid\Logger\LogData;
use Parsoid\Utils\Util;
use Psr\Log\LoggerInterface;
use Psr\Log\NullLogger;

/**
 * Site-level configuration interface for Parsoid
 *
 * This includes both global configuration and wiki-level configuration.
 */
abstract class SiteConfig {

	/** @var LoggerInterface|null */
	protected $logger = null;

	/** @var int */
	protected $iwMatcherBatchSize = 4096;

	/** @var array|null */
	private $iwMatcher = null;

	/************************************************************************//**
	 * @name   Global config
	 * @{
	 */

	/**
	 * General log channel
	 * @return LoggerInterface
	 */
	public function getLogger(): LoggerInterface {
		if ( $this->logger === null ) {
			$this->logger = new NullLogger;
		}
		return $this->logger;
	}

	/**
	 * Log channel for traces
	 * @return LoggerInterface
	 */
	public function getTraceLogger(): LoggerInterface {
		return $this->getLogger();
	}

	/**
	 * Test which trace information to log
	 *
	 * Known flags include 'time' and 'time/dompp'.
	 *
	 * @param string $flag Flag name.
	 * @return bool
	 */
	public function hasTraceFlag( string $flag ): bool {
		return false;
	}

	/**
	 * Log channel for dumps
	 * @return LoggerInterface
	 */
	public function getDumpLogger(): LoggerInterface {
		return $this->getLogger();
	}

	/**
	 * Test which state to dump
	 *
	 * Known flags include 'dom:post-dom-diff', 'dom:post-normal', 'dom:post-builder',
	 * various other things beginning 'dom:pre-' and 'dom:post-',
	 * 'wt2html:limits', 'extoutput', and 'tplsrc'.
	 *
	 * @param string $flag Flag name.
	 * @return bool
	 */
	public function hasDumpFlag( string $flag ): bool {
		return false;
	}

	/**
	 * Test in rt test mode (changes some parse & serialization strategies)
	 * @return bool
	 */
	public function rtTestMode(): bool {
		return false;
	}

	/**
	 * When processing template parameters, parse them to HTML and add it to the
	 * template parameters data.
	 * @return bool
	 */
	public function addHTMLTemplateParameters(): bool {
		return false;
	}

	/**
	 * Whether to enable linter Backend.
	 * @return bool|string[] Boolean to enable/disable all linting, or an array
	 *  of enabled linting types.
	 */
	public function linting() {
		return false;
	}

	/**
	 * Maximum run length for Tidy whitespace bug
	 * @return int Length in Unicode codepoints
	 */
	public function tidyWhitespaceBugMaxLength(): int {
		return 100;
	}

	/**
	 * Statistics aggregator, for counting and timing.
	 *
	 * @todo Do we want to continue to have a wrapper that adds an endTiming()
	 *  method instead of using StatsdDataFactoryInterface directly?
	 * @return StatsdDataFactoryInterface|null
	 */
	public function metrics(): ?StatsdDataFactoryInterface {
		return null;
	}

	/**
	 * If enabled, bidi chars adjacent to category links will be stripped
	 * in the html -> wt serialization pass.
	 * @return bool
	 */
	public function scrubBidiChars(): bool {
		return false;
	}

	/**@}*/

	/************************************************************************//**
	 * @name   Wiki config
	 * @{
	 */

	/**
	 * Allowed external image URL prefixes.
	 *
	 * @return string[] The empty array matches no URLs. The empty string matches
	 *  all URLs.
	 */
	abstract public function allowedExternalImagePrefixes(): array;

	/**
	 * Site base URI
	 *
	 * This would be the URI found in `<base href="..." />`.
	 *
	 * @return string
	 */
	abstract public function baseURI(): string;

	/**
	 * Prefix for relative links
	 *
	 * Prefix to prepend to a page title to link to that page.
	 * Intended to be relative to the URI returned by baseURI().
	 *
	 * If possible, keep the default "./" so clients need not know this value
	 * to extract titles from link hrefs.
	 *
	 * @return string
	 */
	public function relativeLinkPrefix(): string {
		return './';
	}

	/**
	 * Regex matching all double-underscore magic words
	 * @return string
	 */
	abstract public function bswPagePropRegexp(): string;

	/**
	 * Map a canonical namespace name to its index
	 *
	 * @note This replaces canonicalNamespaces
	 * @param string $name all-lowercase and with underscores rather than spaces.
	 * @return int|null
	 */
	abstract public function canonicalNamespaceId( string $name ): ?int;

	/**
	 * Map a namespace name to its index
	 *
	 * @note This replaces canonicalNamespaces
	 * @param string $name
	 * @return int|null
	 */
	abstract public function namespaceId( string $name ): ?int;

	/**
	 * Map a namespace index to its preferred name
	 *
	 * @note This replaces namespaceNames
	 * @param int $ns
	 * @return string|null
	 */
	abstract public function namespaceName( int $ns ): ?string;

	/**
	 * Test if a namespace has subpages
	 *
	 * @note This replaces namespacesWithSubpages
	 * @param int $ns
	 * @return bool
	 */
	abstract public function namespaceHasSubpages( int $ns ): bool;

	/**
	 * Return namespace case setting
	 * @param int $ns
	 * @return string 'first-letter' or 'case-sensitive'
	 */
	abstract public function namespaceCase( int $ns ): string;

	/**
	 * Test if a namespace is a talk namespace
	 *
	 * @note This replaces title.getNamespace().isATalkNamespace()
	 * @param int $ns
	 * @return bool
	 */
	public function namespaceIsTalk( int $ns ): bool {
		return $ns > 0 && $ns % 2;
	}

	/**
	 * Uppercasing method for titles
	 * @param string $str
	 * @return string
	 */
	public function ucfirst( string $str ): string {
		$o = ord( $str );
		if ( $o < 96 ) { // if already uppercase...
			return $str;
		} elseif ( $o < 128 ) {
			if ( $str[0] === 'i' &&
				in_array( $this->lang(), [ 'az', 'tr', 'kaa', 'kk' ], true )
			) {
				return 'İ' . mb_substr( $str, 1 );
			}
			return ucfirst( $str ); // use PHP's ucfirst()
		} else {
			// fall back to more complex logic in case of multibyte strings
			$char = mb_substr( $str, 0, 1 );
			return mb_strtoupper( $char ) . mb_substr( $str, 1 );
		}
	}

	/**
	 * Get the canonical name for a special page
	 * @param string $alias Special page alias
	 * @return string|null
	 */
	abstract public function canonicalSpecialPageName( string $alias ): ?string;

	/**
	 * Treat language links as magic connectors, not inline links
	 * @return bool
	 */
	abstract public function interwikiMagic(): bool;

	/**
	 * Interwiki link data
	 * @return array[] Keys are interwiki prefixes, values are arrays with the following keys:
	 *   - prefix: (string) The interwiki prefix, same as the key.
	 *   - url: (string) Target URL, containing a '$1' to be replaced by the interwiki target.
	 *   - protorel: (bool, optional) Whether the url may be accessed by both http:// and https://.
	 *   - local: (bool, optional) Whether the interwiki link is considered local (to the wikifarm).
	 *   - localinterwiki: (bool, optional) Whether the interwiki link points to the current wiki.
	 *   - language: (bool, optional) Whether the interwiki link is a language link.
	 *   - extralanglink: (bool, optional) Whether the interwiki link is an "extra language link".
	 *   - linktext: (string, optional) For "extra language links", the link text.
	 *  (booleans marked "optional" must be omitted if false)
	 */
	abstract public function interwikiMap(): array;

	/**
	 * Match interwiki URLs
	 * @param string $href Link to match against
	 * @return string[]|null Two values [ string $key, string $target ] on success, null on no match.
	 */
	public function interwikiMatcher( string $href ): ?array {
		if ( $this->iwMatcher === null ) {
			$keys = [ [], [] ];
			$patterns = [ [], [] ];
			foreach ( $this->interwikiMap() as $key => $iw ) {
				$lang = (int)( !empty( $iw['language'] ) );

				$url = $iw['url'];
				$protocolRelative = substr( $url, 0, 2 ) === '//';
				if ( !empty( $iw['protorel'] ) ) {
					$url = preg_replace( '/^https?:/', '', $url );
					$protocolRelative = true;
				}

				// full-url match pattern
				$keys[$lang][] = $key;
				$patterns[$lang][] =
					// Support protocol-relative URLs
					( $protocolRelative ? '(?:https?:)?' : '' )
					// Convert placeholder to group match
					. strtr( preg_quote( $url, '/' ), [ '\\$1' => '(.*?)' ] );

				if ( !empty( $iw['local'] ) ) {
					// ./$interwikiPrefix:$title and
					// $interwikiPrefix%3A$title shortcuts
					// are recognized and the local wiki forwards
					// these shortcuts to the remote wiki

					$keys[$lang][] = $key;
					$patterns[$lang][] = '^\\.\\/' . $iw['prefix'] . ':(.*?)';

					$keys[$lang][] = $key;
					$patterns[$lang][] = '^' . $iw['prefix'] . '%3A(.*?)';
				}
			}

			// Prefer language matches over non-language matches
			$numLangs = count( $keys[1] );
			$keys = array_merge( $keys[1], $keys[0] );
			$patterns = array_merge( $patterns[1], $patterns[0] );

			// Chunk patterns into reasonably sized regexes
			$this->iwMatcher = [];
			$batchStart = 0;
			$batchLen = 0;
			foreach ( $patterns as $i => $pat ) {
				$len = strlen( $pat );
				if ( $i !== $batchStart && $batchLen + $len > $this->iwMatcherBatchSize ) {
					$this->iwMatcher[] = [
						array_slice( $keys, $batchStart, $i - $batchStart ),
						'/^(?:' . implode( '|', array_slice( $patterns, $batchStart, $i - $batchStart ) ) . ')$/i',
						$numLangs - $batchStart,
					];
					$batchStart = $i;
					$batchLen = $len;
				} else {
					$batchLen += $len;
				}
			}
			$i = count( $patterns );
			if ( $i > $batchStart ) {
				$this->iwMatcher[] = [
					array_slice( $keys, $batchStart, $i - $batchStart ),
					'/^(?:' . implode( '|', array_slice( $patterns, $batchStart, $i - $batchStart ) ) . ')$/i',
					$numLangs - $batchStart,
				];
			}
		}

		foreach ( $this->iwMatcher as list( $keys, $regex, $numLangs ) ) {
			if ( preg_match( $regex, $href, $m, PREG_UNMATCHED_AS_NULL ) ) {
				foreach ( $keys as $i => $key ) {
					if ( isset( $m[$i + 1] ) ) {
						if ( $i < $numLangs ) {
							// Escape language interwikis with a colon
							$key = ':' . $key;
						}
						return [ $key, $m[$i + 1] ];
					}
				}
			}
		}
		return null;
	}

	/**
	 * Wiki identifier, for cache keys.
	 * Should match a key in mwApiMap()?
	 * @return string
	 */
	abstract public function iwp(): string;

	/**
	 * Legal title characters
	 *
	 * Regex is intended to match bytes, not Unicode characters.
	 *
	 * @return string Regex character class (i.e. the bit that goes inside `[]`)
	 */
	abstract public function legalTitleChars() : string;

	/**
	 * Link prefix regular expression.
	 * @return string|null
	 */
	abstract public function linkPrefixRegex(): ?string;

	/**
	 * Link trail regular expression.
	 * @return string|null
	 */
	abstract public function linkTrailRegex(): ?string;

	/**
	 * Log linter data.
	 * @note This replaces JS linterEnabled.
	 * @param LogData $logData
	 */
	public function logLinterData( LogData $logData ): void {
		// In MW, call a hook that the Linter extension will listen on
	}

	/**
	 * Wiki language code.
	 * @return string
	 */
	abstract public function lang(): string;

	/**
	 * Main page title
	 * @return string
	 */
	abstract public function mainpage(): string;

	/**
	 * Responsive references configuration
	 * @return array With two keys:
	 *  - enabled: (bool) Whether it's enabled
	 *  - threshold: (int) Threshold
	 */
	abstract public function responsiveReferences(): array;

	/**
	 * Whether the wiki language is right-to-left
	 * @return bool
	 */
	abstract public function rtl(): bool;

	/**
	 * Whether language converter is enabled for the specified language
	 * @param string $lang Language code
	 * @return bool
	 */
	abstract public function langConverterEnabled( string $lang ): bool;

	/**
	 * The URL path to index.php.
	 * @return string
	 */
	abstract public function script(): string;

	/**
	 * The base wiki path
	 * @return string
	 */
	abstract public function scriptpath(): string;

	/**
	 * The base URL of the server.
	 * @return string
	 */
	abstract public function server(): string;

	/**
	 * Get the base URL for loading resource modules
	 * This is the $wgLoadScript config value.
	 *
	 * This base class provides the default value.
	 * Derived classes should override appropriately.
	 *
	 * @return string
	 */
	public function getModulesLoadURI(): string {
		return $this->server() . $this->scriptpath() . '/load.php';
	}

	/**
	 * A regex matching a line containing just whitespace, comments, and
	 * sol transparent links and behavior switches.
	 * @return string
	 */
	abstract public function solTransparentWikitextRegexp(): string;

	/**
	 * A regex matching a line containing just comments and
	 * sol transparent links and behavior switches.
	 * @return string
	 */
	abstract public function solTransparentWikitextNoWsRegexp(): string;

	/**
	 * The wiki's time zone offset
	 * @return int Minutes east of UTC
	 */
	abstract public function timezoneOffset(): int;

	/**
	 * Language variant information
	 * @return array Keys are variant codes (e.g. "zh-cn"), values are arrays with two fields:
	 *   - base: (string) Base language code (e.g. "zh")
	 *   - fallbacks: (string[]) Fallback variants
	 */
	abstract public function variants(): array;

	/**
	 * Default thumbnail width
	 * @return int
	 */
	abstract public function widthOption(): int;

	/**
	 * List all magic words by alias
	 * @return string[] Keys are aliases, values are canonical names.
	 */
	abstract public function magicWords(): array;

	/**
	 * List all magic words by canonical name
	 * @return string[][] Keys are canonical names, values are arrays of aliases.
	 */
	abstract public function mwAliases(): array;

	/**
	 * Get canonical magicword name for the input word.
	 *
	 * @param string $word
	 * @return string|null
	 */
	public function magicWordCanonicalName( string $word ): ?string {
		$mws = $this->magicWords();
		return $mws[$word] ?? $mws[mb_strtolower( $word )] ?? null;
	}

	/**
	 * Check if a string is a recognized magic word.
	 *
	 * @param string $word
	 * @return bool
	 */
	public function isMagicWord( string $word ): bool {
		return $this->magicWordCanonicalName( $word ) !== null;
	}

	/**
	 * Convert the internal canonical magic word name to the wikitext alias.
	 * @param string $word Canonical magic word name
	 * @param string $suggest Suggested alias (used as fallback and preferred choice)
	 * @return string
	 */
	public function getMagicWordWT( string $word, string $suggest ): string {
		$aliases = $this->mwAliases()[$word] ?? null;
		if ( !$aliases ) {
			return $suggest;
		}
		$ind = 0;
		if ( $suggest ) {
			$ind = array_search( $suggest, $aliases, true );
		}
		return $aliases[$ind ?: 0];
	}

	/**
	 * Get a regexp matching a localized magic word, given its id.
	 *
	 * FIXME: misleading function name
	 *
	 * @param string $id
	 * @return string
	 */
	abstract public function getMagicWordMatcher( string $id ): string;

	/**
	 * Get a matcher function for fetching values out of interpolated magic words,
	 * ie those with `$1` in their aliases.
	 *
	 * The matcher takes a string and returns null if it doesn't match any of
	 * the words, or an associative array if it did match:
	 *  - k: The magic word that matched
	 *  - v: The value of $1 that was matched
	 * (the JS also returned 'a' with the specific alias that matched, but that
	 * seems to be unused and so is omitted here)
	 *
	 * @param string[] $words Magic words to match
	 * @return callable
	 */
	abstract public function getMagicPatternMatcher( array $words ): callable;

	/**
	 * Determine whether a given name, which must have already been converted
	 * to lower case, is a valid extension tag name.
	 *
	 * @param string $name
	 * @return bool
	 */
	abstract public function isExtensionTag( string $name ): bool;

	/**
	 * Get an array of defined extension tags, with the lower case name in the
	 * key, the value arbitrary.
	 *
	 * @return array
	 */
	abstract public function getExtensionTagNameMap(): array;

	/**
	 * @param string $string Extension tag name
	 * @return SerialHandler|null
	 */
	public function getExtensionTagSerialHandler( string $string ): ?SerialHandler {
		// PORT-FIXME implement (should return the relevant src/Ext class, if it implements SerialHandler)
		throw new \LogicException( 'Not implemented' );
	}

	/**
	 * Get the maximum template depth
	 *
	 * @return int
	 */
	abstract public function getMaxTemplateDepth(): int;

	/**
	 * Matcher for ISBN/RFC/PMID URL patterns, returning the type and number.
	 *
	 * The match method takes a string and returns false on no match or a tuple
	 * like this on match: [ 'RFC', '12345' ]
	 *
	 * @return callable
	 */
	abstract public function getExtResourceURLPatternMatcher(): callable;

	/**
	 * Serialize ISBN/RFC/PMID URL patterns
	 *
	 * @param string[] $match As returned by the getExtResourceURLPatternMatcher() matcher
	 * @param string $href Fallback link target, if $match is invalid.
	 * @param string $content Link text
	 * @return string
	 */
	public function makeExtResourceURL( array $match, string $href, string $content ): string {
		$normalized = preg_replace(
			'/[ \x{00A0}\x{1680}\x{2000}-\x{200A}\x{202F}\x{205F}\x{3000}]+/u', ' ',
			Util::decodeWtEntities( $content )
		);

		// TODO: T145590 ("Update Parsoid to be compatible with magic links being disabled")
		switch ( $match[0] ) {
			case 'ISBN':
				$normalized = strtoupper( preg_replace( '/[\- \t]/', '', $normalized ) );
				// validate ISBN length and format, so as not to produce magic links
				// which aren't actually magic
				$valid = preg_match( '/^ISBN(97[89])?\d{9}(\d|X)$/', $normalized );
				if ( implode( '', $match ) === $normalized && $valid ) {
					return $content;
				}
				// strip "./" prefix. TODO: Use relativeLinkPrefix() instead?
				$href = preg_replace( '!^\./!', '', $href );
				return "[[$href|$content]]";

			case 'RFC':
			case 'PMID':
				$normalized = preg_replace( '/[ \t]/', '', $normalized );
				return implode( '', $match ) === $normalized ? $content : "[$href $content]";

			default:
				throw new \InvalidArgumentException( "Invalid match type '{$match[0]}'" );
		}
	}

	/**
	 * Matcher for valid protocols, must be anchored at start of string.
	 * @param string $potentialLink
	 * @return bool Whether $potentialLink begins with a valid protocol
	 */
	abstract public function hasValidProtocol( string $potentialLink ): bool;

	/**
	 * Matcher for valid protocols, may occur at any point within string.
	 * @param string $potentialLink
	 * @return bool Whether $potentialLink contains a valid protocol
	 */
	abstract public function findValidProtocol( string $potentialLink ): bool;

	/**@}*/

	/**
	 * Fake timestamp, for unit tests.
	 * @return int|null Unix timestamp, or null to not fake it
	 */
	public function fakeTimestamp(): ?int {
		return null;
	}

	/**
	 * Return canonical magic word for a function hook
	 * @param string $str
	 * @return string|null
	 */
	abstract public function getMagicWordForFunctionHook( string $str ): ?string;

	/**
	 * Return canonical magic word for a variable
	 * @param string $str
	 * @return string|null
	 */
	abstract public function getMagicWordForVariable( string $str ): ?string;
}
