<?php
declare( strict_types = 1 );

namespace Parsoid\Config;

use Liuggio\StatsdClient\Factory\StatsdDataFactoryInterface;
use Parsoid\Logger\LogData;
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
	 * Whether we should use the PHP Preprocessor to expand templates,
	 * extension content, and the like.
	 *
	 * See #PHPPreProcessorRequest in lib/mediawiki.ApiRequest.js
	 *
	 * @todo Eventually we'll have to finish implementing preprocessing natively,
	 *  then this should go away.
	 * @return bool
	 */
	public function usePHPPreProcessor(): bool {
		return true;
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
	 * Wiki identifier, for cache keys.
	 * Should match a key in mwApiMap()?
	 * @return string
	 */
	abstract public function iwp(): string;

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
	 * Matcher for RFC/PMID URL patterns, returning the type and number.
	 *
	 * The match method takes a string and returns false on no match or a tuple
	 * like this on match: [ 'RFC', '12345' ]
	 *
	 * @return callable
	 */
	abstract public function getExtResourceURLPatternMatcher(): callable;

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

}

/**
 * For really cool vim folding this needs to be at the end:
 * vim: foldmarker=@{,@} foldmethod=marker
 */
