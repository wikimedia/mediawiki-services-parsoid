<?php

declare( strict_types = 1 );

namespace Parsoid\Config\Api;

use Parsoid\Config\SiteConfig as ISiteConfig;
use Parsoid\Utils\PHPUtils;
use Parsoid\Utils\Util;
use Psr\Log\AbstractLogger;
use Psr\Log\LoggerInterface;

/**
 * SiteConfig via MediaWiki's Action API
 *
 * Note this is intended for testing, not performance.
 */
class SiteConfig extends ISiteConfig {

	/** @var ApiHelper */
	private $api;

	/** @var bool */
	private $rtTestMode = false;

	/** @var array|null */
	private $siteData, $protocols;

	/** @var string|null */
	private $baseUri, $relativeLinkPrefix, $bswPagePropRegexp,
		$solTransparentWikitextRegexp, $solTransparentWikitextNoWsRegexp;

	/** @var string|null|bool */
	private $linkTrailRegex = false;

	/** @var array<int,string> */
	private $nsNames;

	/** @var array<string,int> */
	private $nsIds, $nsCanon;

	/** @var array<int,bool> */
	private $nsWithSubpages;

	/** @var array|null */
	private $interwikiMap, $variants,
		$langConverterEnabled, $magicWords, $mwAliases, $paramMWs,
		$allMWs, $extensionTags;

	/** @var int|null */
	private $widthOption;

	/** @var callable|null */
	private $extResourceURLPatternMatcher;

	/**
	 * Quote a title regex
	 *
	 * Assumes '/' as the delimiter, and replaces spaces or underscores with
	 * `[ _]` so either will be matched.
	 *
	 * @param string $s
	 * @return string
	 */
	private static function quoteTitleRe( string $s ): string {
		$s = preg_quote( $s, '/' );
		$s = strtr( $s, [
			' ' => '[ _]',
			'_' => '[ _]',
		] );
		return $s;
	}

	/**
	 * @param ApiHelper $api
	 * @param array $opts
	 */
	public function __construct( ApiHelper $api, array $opts ) {
		$this->api = $api;

		$this->rtTestMode = !empty( $opts['rtTestMode'] );

		$this->nsNames = [];
		$this->nsCanon = [];
		$this->nsIds = [];
		$this->nsWithSubpages = [];

		if ( !empty( $opts['log'] ) ) {
			$this->setLogger( new class extends AbstractLogger {
				/** @inheritDoc */
				public function log( $level, $message, array $context = [] ) {
					if ( $context ) {
						$message = preg_replace_callback( '/\{([A-Za-z0-9_.]+)\}/', function ( $m ) use ( $context ) {
							if ( isset( $context[$m[1]] ) ) {
								$v = $context[$m[1]];
								if ( is_scalar( $v ) || is_object( $v ) && is_callable( [ $v, '__toString' ] ) ) {
									return (string)$v;
								}
							}
							return $m[0];
						}, $message );

						fprintf( STDERR, "[%s] %s %s\n", $level, $message,
							PHPUtils::jsonEncode( $context )
						);
					} else {
						fprintf( STDERR, "[%s] %s\n", $level, $message );
					}
				}
			} );
		}
	}

	/**
	 * Normalize a namespace name
	 * @param string $name
	 * @return string
	 */
	private function normalizeNsName( string $name ): string {
		return strtr( mb_strtolower( $name ), ' ', '_' );
	}

	/**
	 * Combine sets of regex fragments
	 * @param string[][] $res
	 *  - $regexes[0] are case-insensitive regex fragments. Must not be empty.
	 *  - $regexes[1] are case-sensitive regex fragments. Must not be empty.
	 * @return string Combined regex fragment. May be an alternation. Assumes
	 *  the outer environment is case-sensitive.
	 */
	private function combineRegexArrays( array $res ): string {
		if ( $res ) {
			if ( isset( $res[0] ) ) {
				$res[0] = '(?i:' . implode( '|', $res[0] ) . ')';
			}
			if ( isset( $res[1] ) ) {
				$res[1] = '(?:' . implode( '|', $res[1] ) . ')';
			}
			return implode( '|', $res );
		}
		// None? Return a failing regex
		return '(?!)';
	}

	/**
	 * Load site data from the Action API, if necessary
	 */
	private function loadSiteData(): void {
		if ( $this->siteData !== null ) {
			return;
		}

		$data = $this->api->makeRequest( [
			'action' => 'query',
			'meta' => 'siteinfo',
			'siprop' => 'general|protocols|namespaces|namespacealiases|magicwords|interwikimap|'
				. 'languagevariants|defaultoptions|specialpagealiases|extensiontags',
		] )['query'];

		$this->siteData = $data['general'];
		$this->widthOption = $data['general']['thumblimits'][$data['defaultoptions']['thumbsize']];
		$this->protocols = $data['protocols'];

		// Process namespace data from API
		foreach ( $data['namespaces'] as $ns ) {
			$id = (int)$ns['id'];
			$this->nsNames[$id] = $ns['name'];
			$this->nsIds[$this->normalizeNsName( $ns['name'] )] = $id;
			$this->nsCanon[$this->normalizeNsName( $ns['canonical'] ?? $ns['name'] )] = $id;
			if ( $ns['subpages'] ) {
				$this->nsWithSubpages[$id] = true;
			}
		}
		foreach ( $data['namespacealiases'] as $ns ) {
			$this->nsIds[$this->normalizeNsName( $ns['alias'] )] = $ns['id'];
		}

		// Process magic word data from API
		$bsws = [];
		$this->magicWords = [];
		$this->mwAliases = [];
		$this->paramMWs = [];
		$this->allMWs = [];
		foreach ( $data['magicwords'] as $mw ) {
			$cs = (int)$mw['case-sensitive'];
			$pmws = [];
			$allMWs = [];
			foreach ( $mw['aliases'] as $alias ) {
				if ( substr( $alias, 0, 2 ) === '__' && substr( $alias, -2 ) === '__' ) {
					$bsws[$cs][] = preg_quote( substr( $alias, 2, -2 ), '/' );
				}
				if ( strpos( $alias, '$1' ) !== false ) {
					$pmws[$cs][] = strtr( preg_quote( $alias, '/' ), [ '\\$1' => "(.*?)" ] );
				}
				$allMWs[$cs][] = preg_quote( $alias, '/' );

				$this->mwAliases[$mw['name']][] = $alias;
				if ( !$cs ) {
					$alias = mb_strtolower( $alias );
					$this->mwAliases[$mw['name']][] = $alias;
				}

				$this->magicWords[$alias] = $mw['name'];
			}

			if ( $pmws ) {
				$this->paramMWs[$mw['name']] = '/^(?:' . $this->combineRegexArrays( $pmws ) . ')$/uS';
			}
			$this->allMWs[$mw['name']] = '/^(?:' . $this->combineRegexArrays( $allMWs ) . ')$/';
		}

		$bswRegexp = $this->combineRegexArrays( $bsws );
		$this->bswPagePropRegexp = '/(?:^|\\s)mw:PageProp\/(?:' . $bswRegexp . ')(?=$|\\s)/uS';

		// Parse interwiki map data from the API
		$this->interwikiMap = [];
		$keys = [
			'prefix' => true,
			'url' => true,
			'protorel' => true,
			'local' => true,
			'localinterwiki' => true,
			'language' => true,
			'extralanglink' => true,
			'linktext' => true,
		];
		$cb = function ( $v ) {
			return $v !== false;
		};
		foreach ( $data['interwikimap'] as $iwdata ) {
			$iwdata['language'] = isset( $iwdata['language'] );
			if ( strpos( $iwdata['url'], '$1' ) === false ) {
				$iwdata['url'] .= '$1';
			}
			$iwdata = array_intersect_key( $iwdata, $keys );

			$this->interwikiMap[$iwdata['prefix']] = array_filter( $iwdata, $cb );
		}

		// Parse variant data from the API
		$this->langConverterEnabled = [];
		$this->variants = [];
		foreach ( $data['languagevariants'] as $base => $variants ) {
			if ( $this->siteData['langconversion'] ) {
				$this->langConverterEnabled[$base] = true;
			}
			foreach ( $variants as $code => $vdata ) {
				$this->variants[$code] = [
					'base' => $base,
					'fallbacks' => $vdata['fallbacks'],
				];
			}
		}

		// Parse extension tag data from the API
		$this->extensionTags = [];
		foreach ( $data['extensiontags'] as $tag ) {
			$tag = preg_replace( '/^<|>$/', '', $tag );
			$this->extensionTags[mb_strtolower( $tag )] = true;
		}

		// extResourceURLPatternMatcher
		$nsAliases = [
			'Special',
		];
		foreach ( $this->nsIds as $name => $id ) {
			if ( $id === -1 ) {
				$nsAliases[] = $this->quoteTitleRe( $name );
			}
		}
		$nsAliases = implode( '|', array_unique( $nsAliases ) );

		$bsAliases = [ 'Booksources' ];
		foreach ( $data['specialpagealiases'] as $special ) {
			if ( $special['realname'] === 'Booksources' ) {
				$bsAliases = array_merge( $bsAliases, $special['aliases'] );
				break;
			}
		}
		$pageAliases = implode( '|', array_map( [ $this, 'quoteTitleRe' ], $bsAliases ) );

		// cscott wants a mention of T145590 here ("Update Parsoid to be compatible with magic links
		// being disabled")
		$pats = [
			'ISBN' => '(?:\.\.?/)*(?i:' . $nsAliases . ')(?:%3[Aa]|:)'
				. '(?i:' . $pageAliases . ')(?:%2[Ff]|/)(?P<ISBN>\d+[Xx]?)',
			'RFC' => '[^/]*//tools\.ietf\.org/html/rfc(?P<RFC>\w+)',
			'PMID' => '[^/]*//www\.ncbi\.nlm\.nih\.gov/pubmed/(?P<PMID>\w+)\?dopt=Abstract',
		];
		$regex = '!^(?:' . implode( '|', $pats ) . ')$!';
		$this->extResourceURLPatternMatcher = function ( $text ) use ( $pats, $regex ) {
			if ( preg_match( $regex, $text, $m ) ) {
				foreach ( $pats as $k => $re ) {
					if ( isset( $m[$k] ) && $m[$k] !== '' ) {
						return [ $k, $m[$k] ];
					}
				}
			}
			return false;
		};

		// solTransparentWikitext and solTransparentWikitextNoWsRegexp
		// cscott sadly says: Note that this depends on the precise
		// localization of the magic words of this particular wiki.

		$redirect = '(?i:#REDIRECT)';
		foreach ( $data['magicwords'] as $mw ) {
			if ( $mw['name'] === 'redirect' ) {
				$redirect = implode( '|', array_map( 'preg_quote', $mw['aliases'] ) );
				if ( !$mw['case-sensitive'] ) {
					$redirect = '(?i:' . $redirect . ')';
				}
				break;
			}
		}
		$category = $this->quoteTitleRe( $this->nsNames[14] ?? 'Category' );
		if ( $category !== 'Category' ) {
			$category = "(?:$category|Category)";
		}

		$this->solTransparentWikitextRegexp = '!' .
			'^[ \t\n\r\0\x0b]*' .
			'(?:' .
			  '(?:' . $redirect . ')' .
			  '[ \t\n\r\x0c]*(?::[ \t\n\r\x0c]*)?\[\[[^\]]+\]\]' .
			')?' .
			'(?:' .
			  '\[\[' . $category . '\:[^\]]*?\]\]|' .
			  '__(?:' . $bswRegexp . ')__|' .
			  PHPUtils::reStrip( Util::COMMENT_REGEXP, '!' ) . '|' .
			  '[ \t\n\r\0\x0b]' .
			')*$!i';

		$this->solTransparentWikitextNoWsRegexp = '!' .
			'((?:' .
			  '(?:' . $redirect . ')' .
			  '[ \t\n\r\x0c]*(?::[ \t\n\r\x0c]*)?\[\[[^\]]+\]\]' .
			')?' .
			'(?:' .
			  '\[\[' . $category . '\:[^\]]*?\]\]|' .
			  '__(?:' . $bswRegexp . ')__|' .
			  PHPUtils::reStrip( Util::COMMENT_REGEXP, '!' ) .
			')*)!i';
	}

	/**
	 * Set the log channel, for debugging
	 * @param LoggerInterface|null $logger
	 */
	public function setLogger( ?LoggerInterface $logger ): void {
		$this->logger = $logger;
	}

	public function rtTestMode(): bool {
		return $this->rtTestMode;
	}

	public function allowedExternalImagePrefixes(): array {
		$this->loadSiteData();
		return $this->siteData['externalimages'] ?? [];
	}

	/**
	 * Parse a URL into components
	 * @note Mostly copied from MediaWiki's wfParseUrl
	 * @param string $url
	 * @return array|false
	 */
	private function parseUrl( string $url ) {
		// Protocol-relative URLs are handled really badly by parse_url(). It's so
		// bad that the easiest way to handle them is to just prepend 'http:' and
		// strip the protocol out later.
		$wasRelative = substr( $url, 0, 2 ) == '//';
		if ( $wasRelative ) {
			$url = "http:$url";
		}

		$bits = parse_url( $url );

		// parse_url() returns an array without scheme for some invalid URLs, e.g.
		// parse_url("%0Ahttp://example.com") == [ 'host' => '%0Ahttp', 'path' => 'example.com' ]
		if ( !$bits || !isset( $bits['scheme'] ) ) {
			return false;
		}

		// parse_url() incorrectly handles schemes case-sensitively. Convert it to lowercase.
		$bits['scheme'] = strtolower( $bits['scheme'] );

		// We don't care about weird schemes here
		if ( $bits['scheme'] !== 'http' && $bits['scheme'] !== 'https' ) {
			return false;
		}
		$bits['delimiter'] = '://';

		// If the URL was protocol-relative, fix scheme and delimiter
		if ( $wasRelative ) {
			$bits['scheme'] = '';
			$bits['delimiter'] = '//';
		}
		return $bits;
	}

	/**
	 * Remove all dot-segments in the provided URL path.  For example,
	 * '/a/./b/../c/' becomes '/a/c/'.  For details on the algorithm, please see
	 * RFC3986 section 5.2.4.
	 *
	 * @note Copied from MediaWiki's wfRemoveDotSegments
	 * @param string $urlPath URL path, potentially containing dot-segments
	 * @return string URL path with all dot-segments removed
	 */
	private function removeDotSegments( string $urlPath ): string {
		$output = '';
		$inputOffset = 0;
		$inputLength = strlen( $urlPath );

		while ( $inputOffset < $inputLength ) {
			$prefixLengthOne = substr( $urlPath, $inputOffset, 1 );
			$prefixLengthTwo = substr( $urlPath, $inputOffset, 2 );
			$prefixLengthThree = substr( $urlPath, $inputOffset, 3 );
			$prefixLengthFour = substr( $urlPath, $inputOffset, 4 );
			$trimOutput = false;

			if ( $prefixLengthTwo == './' ) {
				# Step A, remove leading "./"
				$inputOffset += 2;
			} elseif ( $prefixLengthThree == '../' ) {
				# Step A, remove leading "../"
				$inputOffset += 3;
			} elseif ( ( $prefixLengthTwo == '/.' ) && ( $inputOffset + 2 == $inputLength ) ) {
				# Step B, replace leading "/.$" with "/"
				$inputOffset += 1;
				$urlPath[$inputOffset] = '/';
			} elseif ( $prefixLengthThree == '/./' ) {
				# Step B, replace leading "/./" with "/"
				$inputOffset += 2;
			} elseif ( $prefixLengthThree == '/..' && ( $inputOffset + 3 == $inputLength ) ) {
				# Step C, replace leading "/..$" with "/" and
				# remove last path component in output
				$inputOffset += 2;
				$urlPath[$inputOffset] = '/';
				$trimOutput = true;
			} elseif ( $prefixLengthFour == '/../' ) {
				# Step C, replace leading "/../" with "/" and
				# remove last path component in output
				$inputOffset += 3;
				$trimOutput = true;
			} elseif ( ( $prefixLengthOne == '.' ) && ( $inputOffset + 1 == $inputLength ) ) {
				# Step D, remove "^.$"
				$inputOffset += 1;
			} elseif ( ( $prefixLengthTwo == '..' ) && ( $inputOffset + 2 == $inputLength ) ) {
				# Step D, remove "^..$"
				$inputOffset += 2;
			} else {
				# Step E, move leading path segment to output
				if ( $prefixLengthOne == '/' ) {
					$slashPos = strpos( $urlPath, '/', $inputOffset + 1 );
				} else {
					$slashPos = strpos( $urlPath, '/', $inputOffset );
				}
				if ( $slashPos === false ) {
					$output .= substr( $urlPath, $inputOffset );
					$inputOffset = $inputLength;
				} else {
					$output .= substr( $urlPath, $inputOffset, $slashPos - $inputOffset );
					$inputOffset += $slashPos - $inputOffset;
				}
			}

			if ( $trimOutput ) {
				$slashPos = strrpos( $output, '/' );
				if ( $slashPos === false ) {
					$output = '';
				} else {
					$output = substr( $output, 0, $slashPos );
				}
			}
		}

		return $output;
	}

	/**
	 * This function will reassemble a URL parsed with wfParseURL.  This is useful
	 * if you need to edit part of a URL and put it back together.
	 *
	 * This is the basic structure used (brackets contain keys for $urlParts):
	 * [scheme][delimiter][user]:[pass]@[host]:[port][path]?[query]#[fragment]
	 *
	 * @note Copied from MediaWiki's assembleUrl
	 * @param array $urlParts URL parts, as output from wfParseUrl
	 * @return string URL assembled from its component parts
	 */
	private function assembleUrl( array $urlParts ): string {
		$result = '';

		if ( isset( $urlParts['delimiter'] ) ) {
			if ( isset( $urlParts['scheme'] ) ) {
				$result .= $urlParts['scheme'];
			}

			$result .= $urlParts['delimiter'];
		}

		if ( isset( $urlParts['host'] ) ) {
			if ( isset( $urlParts['user'] ) ) {
				$result .= $urlParts['user'];
				if ( isset( $urlParts['pass'] ) ) {
					$result .= ':' . $urlParts['pass'];
				}
				$result .= '@';
			}

			$result .= $urlParts['host'];

			if ( isset( $urlParts['port'] ) ) {
				$result .= ':' . $urlParts['port'];
			}
		}

		if ( isset( $urlParts['path'] ) ) {
			$result .= $urlParts['path'];
		}

		if ( isset( $urlParts['query'] ) ) {
			$result .= '?' . $urlParts['query'];
		}

		if ( isset( $urlParts['fragment'] ) ) {
			$result .= '#' . $urlParts['fragment'];
		}

		return $result;
	}

	/**
	 * Determine the article base URI and relative prefix
	 */
	private function determineArticlePath(): void {
		$this->loadSiteData();

		$url = $this->siteData['server'] . $this->siteData['articlepath'];

		if ( substr( $url, -2 ) !== '$1' ) {
			throw new \UnexpectedValueException( "Article path '$url' does not have '$1' at the end" );
		}
		$url = substr( $url, 0, -2 );

		$bits = $this->parseUrl( $url );
		if ( !$bits ) {
			throw new \UnexpectedValueException( "Failed to parse article path '$url'" );
		}

		if ( empty( $bits['path'] ) ) {
			$path = '/';
		} else {
			$path = $this->removeDotSegments( $bits['path'] );
		}

		$relParts = [ 'query' => true, 'fragment' => true ];
		$base = array_diff_key( $bits, $relParts );
		$rel = array_intersect_key( $bits, $relParts );

		$i = strrpos( $path, '/' );
		$base['path'] = substr( $path, 0, $i + 1 );
		$rel['path'] = '.' . substr( $path, $i );

		$this->baseUri = $this->assembleUrl( $base );
		$this->relativeLinkPrefix = $this->assembleUrl( $rel );
	}

	public function baseURI(): string {
		if ( $this->baseUri === null ) {
			$this->determineArticlePath();
		}
		return $this->baseUri;
	}

	public function relativeLinkPrefix(): string {
		if ( $this->relativeLinkPrefix === null ) {
			$this->determineArticlePath();
		}
		return $this->relativeLinkPrefix;
	}

	public function bswPagePropRegexp(): string {
		$this->loadSiteData();
		return $this->bswPagePropRegexp;
	}

	/** @inheritDoc */
	public function canonicalNamespaceId( string $name ): ?int {
		$this->loadSiteData();
		return $this->nsCanon[$this->normalizeNsName( $name )] ?? null;
	}

	/** @inheritDoc */
	public function namespaceId( string $name ): ?int {
		$this->loadSiteData();
		return $this->nsIds[$this->normalizeNsName( $name )] ?? null;
	}

	/** @inheritDoc */
	public function namespaceName( int $ns ): ?string {
		$this->loadSiteData();
		return $this->nsNames[$ns] ?? null;
	}

	/** @inheritDoc */
	public function namespaceHasSubpages( int $ns ): bool {
		$this->loadSiteData();
		return $this->nsWithSubpages[$ns] ?? false;
	}

	public function interwikiMagic(): bool {
		$this->loadSiteData();
		return $this->siteData['interwikimagic'];
	}

	public function interwikiMap(): array {
		$this->loadSiteData();
		return $this->interwikiMap;
	}

	public function iwp(): string {
		$this->loadSiteData();
		return $this->siteData['wikiid'];
	}

	public function linkPrefixRegex(): ?string {
		$this->loadSiteData();

		if ( !empty( $this->siteData['linkprefixcharset'] ) ) {
			return '/[' . $this->siteData['linkprefixcharset'] . ']+$/u';
		} else {
			// We don't care about super-old MediaWiki, so don't try to parse 'linkprefix'.
			return null;
		}
	}

	public function linkTrailRegex(): ?string {
		if ( $this->linkTrailRegex === false ) {
			$this->loadSiteData();
			$trail = $this->siteData['linktrail'];
			$trail = str_replace( '(.*)$', '', $trail );
			if ( strpos( $trail, '()' ) !== false ) {
				// Empty regex from zh-hans
				$this->linkTrailRegex = null;
			} else {
				$this->linkTrailRegex = $trail;
			}
		}
		return $this->linkTrailRegex;
	}

	public function lang(): string {
		$this->loadSiteData();
		return $this->siteData['lang'];
	}

	public function mainpage(): string {
		$this->loadSiteData();
		return $this->siteData['mainpage'];
	}

	public function responsiveReferences(): array {
		$this->loadSiteData();
		return [
			'enabled' => $this->siteData['citeresponsivereferences'] ?? false,
			'threshold' => 10,
		];
	}

	public function rtl(): bool {
		$this->loadSiteData();
		return $this->siteData['rtl'];
	}

	/** @inheritDoc */
	public function langConverterEnabled( string $lang ): bool {
		$this->loadSiteData();
		return $this->langConverterEnabled[$lang] ?? false;
	}

	public function script(): string {
		$this->loadSiteData();
		return $this->siteData['script'];
	}

	public function scriptpath(): string {
		$this->loadSiteData();
		return $this->siteData['scriptpath'];
	}

	public function server(): string {
		$this->loadSiteData();
		return $this->siteData['server'];
	}

	public function solTransparentWikitextRegexp(): string {
		$this->loadSiteData();
		return $this->solTransparentWikitextRegexp;
	}

	public function solTransparentWikitextNoWsRegexp(): string {
		$this->loadSiteData();
		return $this->solTransparentWikitextNoWsRegexp;
	}

	public function timezoneOffset(): int {
		$this->loadSiteData();
		return $this->siteData['timeoffset'];
	}

	public function variants(): array {
		$this->loadSiteData();
		return $this->variants;
	}

	public function widthOption(): int {
		$this->loadSiteData();
		return $this->widthOption;
	}

	public function magicWords(): array {
		$this->loadSiteData();
		return $this->magicWords;
	}

	public function mwAliases(): array {
		$this->loadSiteData();
		return $this->mwAliases;
	}

	/** @inheritDoc */
	public function getMagicWordMatcher( string $id ): string {
		$this->loadSiteData();
		return $this->allMWs[$id] ?? '/^(?!)$/';
	}

	/** @inheritDoc */
	public function getMagicPatternMatcher( array $words ): callable {
		$this->loadSiteData();
		$regexes = array_intersect_key( $this->paramMWs, array_flip( $words ) );
		return function ( $text ) use ( $regexes ) {
			foreach ( $regexes as $name => $re ) {
				if ( preg_match( $re, $text, $m ) ) {
					unset( $m[0] );
					foreach ( $m as $v ) {
						if ( $v !== '' ) {
							return [ 'k' => $name, 'v' => $v ];
						}
					}
				}
			}
			return null;
		};
	}

	/** @inheritDoc */
	public function isExtensionTag( string $name ): bool {
		$this->loadSiteData();
		return isset( $this->extensionTags[$name] );
	}

	/** @inheritDoc */
	public function getExtensionTagNameMap(): array {
		$this->loadSiteData();
		return $this->extensionTags;
	}

	/** @inheritDoc */
	public function getMaxTemplateDepth(): int {
		// Not in the API result
		return 40;
	}

	/** @inheritDoc */
	public function getExtResourceURLPatternMatcher(): callable {
		$this->loadSiteData();
		return $this->extResourceURLPatternMatcher;
	}

	/** @inheritDoc */
	public function hasValidProtocol( string $potentialLink ): bool {
		$this->loadSiteData();
		$regex = '!^(?:' . implode( '|', array_map( 'preg_quote', $this->protocols ) ) . ')!i';
		return (bool)preg_match( $regex, $potentialLink );
	}

	/** @inheritDoc */
	public function findValidProtocol( string $potentialLink ): bool {
		$this->loadSiteData();
		$regex = '!(?:\W|^)(?:' . implode( '|', array_map( 'preg_quote', $this->protocols ) ) . ')!i';
		return (bool)preg_match( $regex, $potentialLink );
	}

}
