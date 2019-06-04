<?php

namespace MWParsoid\Config;

// phpcs:disable MediaWiki.Commenting.FunctionComment.MissingDocumentationPublic

use Config;
use FakeConverter;
use Language;
use LanguageConverter;
use MediaWiki\Logger\LoggerFactory;
use MediaWiki\MediaWikiServices;

use Parsoid\Config\SiteConfig as ISiteConfig;
// use Parsoid\Logger\LogData;
// use Parsoid\Utils\Util;
use Psr\Log\LoggerInterface;
use User;

/**
 * Site-level configuration for Parsoid
 *
 * This includes both global configuration and wiki-level configuration.
 *
 * @todo This belongs in MediaWiki, not Parsoid. We'll move it there when we
 *  get to the point of integrating the two.
 */
class SiteConfig extends ISiteConfig {

	/** @var Config MediaWiki configuration object */
	private $config;

	/** @var Language */
	private $contLang;

	/** @var LoggerInterface|null */
	private $traceLogger, $dumpLogger;

	/** @var string|null */
	private $baseUri, $relativeLinkPrefix, $bswRegexp, $bswPagePropRegexp;

	/** @var string|null|bool */
	private $linkTrailRegex = false;

	/** @var array|null */
	private $interwikiMap, $variants, $magicWords, $mwAliases;

	/** @var array */
	private $extensionTags;

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

	public function __construct() {
		$services = MediaWikiServices::getInstance();
		$this->config = $services->getMainConfig();
		$this->contLang = $services->getContentLanguage();
	}

	/** @inheritDoc */
	public function getLogger(): LoggerInterface {
		if ( $this->logger === null ) {
			$this->logger = LoggerFactory::getInstance( 'Parsoid' );
		}
		return $this->logger;
	}

	/** @inheritDoc */
	public function getTraceLogger(): LoggerInterface {
		if ( $this->traceLogger === null ) {
			$this->traceLogger = LoggerFactory::getInstance( 'ParsoidTrace' );
		}
		return $this->traceLogger;
	}

	/** @inheritDoc */
	public function hasTraceFlag( string $flag ): bool {
		// @todo: Implement this
		return false;
	}

	/** @inheritDoc */
	public function getDumpLogger(): LoggerInterface {
		if ( $this->dumpLogger === null ) {
			$this->dumpLogger = LoggerFactory::getInstance( 'ParsoidDump' );
		}
		return $this->dumpLogger;
	}

	/** @inheritDoc */
	public function hasDumpFlag( string $flag ): bool {
		// @todo: Implement this
		return false;
	}

	public function linting() {
		// @todo: Add $wgParsoidLinting to MW's DefaultSettings.php
		return $this->config->has( 'ParsoidLinting' )
			? $this->config->get( 'ParsoidLinting' )
			: parent::linting();
	}

	public function metrics(): ?StatsdDataFactoryInterface {
		return MediaWikiServices::getInstance()->getStatsdDataFactory();
	}

	public function allowedExternalImagePrefixes(): array {
		if ( $this->config->get( 'AllowExternalImages' ) ) {
			return [ '' ];
		} else {
			$allowFrom = $this->config->get( 'AllowExternalImagesFrom' );
			return $allowFrom ? (array)$allowFrom : [];
		}
	}

	/**
	 * Determine the article base URI and relative prefix
	 *
	 * Populates `$this->baseUri` and `$this->relativeLinkPrefix` based on
	 * `$wgServer` and `$wgArticlePath`, by splitting it at the last '/' in the
	 * path portion.
	 */
	private function determineArticlePath(): void {
		$url = $this->config->get( 'Server' ) . $this->config->get( 'ArticlePath' );

		if ( substr( $url, -2 ) !== '$1' ) {
			throw new \UnexpectedValueException( "Article path '$url' does not have '$1' at the end" );
		}
		$url = substr( $url, 0, -2 );

		$bits = wfParseUrl( $url );
		if ( !$bits ) {
			throw new \UnexpectedValueException( "Failed to parse article path '$url'" );
		}

		if ( empty( $bits['path'] ) ) {
			$path = '/';
		} else {
			$path = wfRemoveDotSegments( $bits['path'] );
		}

		$relParts = [ 'query' => true, 'fragment' => true ];
		$base = array_diff_key( $bits, $relParts );
		$rel = array_intersect_key( $bits, $relParts );

		$i = strrpos( $path, '/' );
		$base['path'] = substr( $path, 0, $i + 1 );
		$rel['path'] = '.' . substr( $path, $i );

		$this->baseUri = wfAssembleUrl( $base );
		$this->relativeLinkPrefix = wfAssembleUrl( $rel );
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
		if ( $this->bswPagePropRegexp === null ) {
			// [0] is the case-insensitive part, [1] is the case-sensitive part
			$regex = MediaWikiServices::getInstance()->getMagicWordFactory()
				->getDoubleUnderscoreArray()->getBaseRegex();
			if ( $regex[0] === '' ) {
				unset( $regex[0] );
			} else {
				$regex[0] = '(?i:' . $regex[0] . ')';
			}
			if ( $regex[1] === '' ) {
				unset( $regex[1] );
			}

			if ( $regex ) {
				$this->bswRegexp = implode( '|', $regex );
			} else {
				// No magic words? Return a failing regex
				$this->bswRegexp = '(?!)';
			}
			$this->bswPagePropRegexp = '/(?:^|\\s)mw:PageProp/(?:' . $this->bswRegexp . ')(?=$|\\s)/uS';
		}
		return $this->bswPagePropRegexp;
	}

	/** @inheritDoc */
	public function canonicalNamespaceId( string $name ): ?int {
		$ret = MediaWikiServices::getInstance()->getNamespaceInfo()->getCanonicalIndex( $name );
		return $ret === false ? null : $ret;
	}

	/** @inheritDoc */
	public function namespaceId( string $name ): ?int {
		$ret = $this->contLang->getNsIndex( $name );
		return $ret === false ? null : $ret;
	}

	/** @inheritDoc */
	public function namespaceName( int $ns ): ?string {
		$ret = $this->contLang->getFormattedNsText( $ns );
		return $ret === '' && $ns !== NS_MAIN ? null : $ret;
	}

	/** @inheritDoc */
	public function namespaceHasSubpages( int $ns ): bool {
		return MediaWikiServices::getInstance()->getNamespaceInfo()->hasSubpages( $ns );
	}

	/** @inheritDoc */
	public function namespaceCase( int $ns ): string {
		$nsInfo = MediaWikiServices::getInstance()->getNamespaceInfo();
		return $nsInfo->isCapitalized( $ns ) ? 'first-letter' : 'case-sensitive';
	}

	/** @inheritDoc */
	public function namespaceIsTalk( int $ns ): bool {
		return MediaWikiServices::getInstance()->getNamespaceInfo()->isTalk( $ns );
	}

	/** @inheritDoc */
	public function ucfirst( string $str ): string {
		return $this->contLang->ucfirst( $str );
	}

	/** @inheritDoc */
	public function canonicalSpecialPageName( string $alias ): ?string {
		return MediaWikiServices::getInstance()->getSpecialPageFactory()->resolveAlias( $alias )[0];
	}

	public function interwikiMagic(): bool {
		return $this->config->get( 'InterwikiMagic' );
	}

	public function interwikiMap(): array {
		// Unfortunate that this mostly duplicates \ApiQuerySiteinfo::appendInterwikiMap()
		if ( $this->interwikiMap === null ) {
			$this->interwikiMap = [];

			$getPrefixes = MediaWikiServices::getInstance()->getInterwikiLookup()->getAllPrefixes( $local );
			$langNames = Language::fetchLanguageNames();
			$extraLangPrefixes = $this->config->get( 'ExtraInterlanguageLinkPrefixes' );
			$localInterwikis = $this->config->get( 'LocalInterwikis' );

			foreach ( $getPrefixes as $row ) {
				$prefix = $row['iw_prefix'];
				$val = [];
				$val['prefix'] = $prefix;
				$val['url'] = wfExpandUrl( $row['iw_url'], PROTO_CURRENT );

				if ( substr( $row['iw_url'], 0, 2 ) == '//' ) {
					$val['protorel'] = substr( $row['iw_url'], 0, 2 ) == '//';
				}
				if ( isset( $row['iw_local'] ) && $row['iw_local'] == '1' ) {
					$val['local'] = true;
				}
				if ( isset( $langNames[$prefix] ) ) {
					$val['language'] = true;
				}
				if ( in_array( $prefix, $localInterwikis ) ) {
					$val['localinterwiki'] = true;
				}
				if ( in_array( $prefix, $extraLangPrefixes ) ) {
					$val['extralanglink'] = true;

					$linktext = wfMessage( "interlanguage-link-$prefix" );
					if ( !$linktext->isDisabled() ) {
						$val['linktext'] = $linktext->text();
					}
				}

				$this->interwikiMap[$prefix] = $val;
			}
		}
		return $this->interwikiMap;
	}

	public function iwp(): string {
		return wfWikiID();
	}

	public function legalTitleChars() : string {
		return Title::legalChars();
	}

	public function linkPrefixRegex(): ?string {
		if ( !$this->contLang->linkPrefixExtension() ) {
			return null;
		}
		return '/[' . $this->contLang->linkPrefixCharset() . ']+$/u';
	}

	public function linkTrailRegex(): ?string {
		if ( $this->linkTrailRegex === false ) {
			$trail = $this->contLang->linkTrail();
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

	/** @inheritDoc */
	public function logLinterData( LogData $logData ): void {
		// @todo: Document this hook in MediaWiki
		Hooks::runWithoutAbort( 'ParsoidLogLinterData', [ $logData ] );
	}

	public function lang(): string {
		return $this->config->get( 'LanguageCode' );
	}

	public function mainpage(): string {
		return Title::newMainPage()->getPrefixedText();
	}

	public function responsiveReferences(): array {
		// @todo This is from the Cite extension, which shouldn't be known about by core
		return [
			'enabled' => $this->config->has( 'CiteResponsiveReferences' ),
			'threshold' => 10,
		];
	}

	public function rtl(): bool {
		return $this->contLang->isRTL();
	}

	/** @inheritDoc */
	public function langConverterEnabled( string $lang ): bool {
		try {
			return !$this->config->get( 'DisableLangConversion' ) &&
				in_array( $lang, LanguageConverter::$languagesWithVariants, true ) &&
				!Language::factory( $lang )->getConverter() instanceof FakeConverter;
		} catch ( \MWException $ex ) {
			// Probably a syntactically invalid language code
			return false;
		}
	}

	public function script(): string {
		return $this->config->get( 'Script' );
	}

	public function scriptpath(): string {
		return $this->config->get( 'ScriptPath' );
	}

	public function server(): string {
		return $this->config->get( 'Server' );
	}

	public function solTransparentWikitextRegexp(): string {
		// cscott sadly says: Note that this depends on the precise
		// localization of the magic words of this particular wiki.

		$mwFactory = MediaWikiServices::getInstance()->getMagicWordFactory();
		$category = $this->quoteTitleRe( $this->contLang->getNsText( NS_CATEGORY ) );
		if ( $category !== 'Category' ) {
			$category = "(?:$category|Category)";
		}
		$this->bswPagePropRegexp(); // populate $this->bswRegexp

		return '!' .
			'^[ \t\n\r\0\x0b]*' .
			'(?:' .
			  '(?:' . $mwFactory->get( 'redirect' )->getRegex() . ')' .
			  '[ \t\n\r\x0c]*(?::[ \t\n\r\x0c]*)?\[\[[^\]]+\]\]' .
			')?' .
			'(?:' .
			  '\[\[' . $category . '\:[^\]]*?\]\]|' .
			  '__(?:' . $this->bswRegexp . ')__|' .
			  Util::COMMENT_REGEXP . '|' .
			  '[ \t\n\r\0\x0b]' .
			')*$!i';
	}

	public function solTransparentWikitextNoWsRegexp(): string {
		// cscott sadly says: Note that this depends on the precise
		// localization of the magic words of this particular wiki.

		$mwFactory = MediaWikiServices::getInstance()->getMagicWordFactory();
		$category = $this->quoteTitleRe( $this->contLang->getNsText( NS_CATEGORY ) );
		if ( $category !== 'Category' ) {
			$category = "(?:$category|Category)";
		}
		$this->bswPagePropRegexp(); // populate $this->bswRegexp

		return '!' .
			'((?:' .
			  '(?:' . $mwFactory->get( 'redirect' )->getRegex() . ')' .
			  '[ \t\n\r\x0c]*(?::[ \t\n\r\x0c]*)?\[\[[^\]]+\]\]' .
			')?' .
			'(?:' .
			  '\[\[' . $category . '\:[^\]]*?\]\]|' .
			  '__(?:' . $this->bswRegexp . ')__|' .
			  Util::COMMENT_REGEXP .
			')*)!i';
	}

	public function timezoneOffset(): int {
		return $this->config->get( 'LocalTZoffset' );
	}

	public function variants(): array {
		if ( $this->variants === null ) {
			$this->variants = [];

			$langNames = LanguageConverter::$languagesWithVariants;
			if ( $this->config->get( 'DisableLangConversion' ) ) {
				// Ensure result is empty if language conversion is disabled.
				$langNames = [];
			}

			foreach ( $langNames as $langCode ) {
				$lang = Language::factory( $langCode );
				if ( $lang->getConverter() instanceof FakeConverter ) {
					// Only languages which do not return instances of
					// FakeConverter implement language conversion.
					continue;
				}

				$variants = $lang->getVariants();
				foreach ( $variants as $v ) {
					$fallbacks = $lang->getConverter()->getVariantFallbacks( $v );
					if ( !is_array( $fallbacks ) ) {
						$fallbacks = [ $fallbacks ];
					}
					$this->variants[$v] = [
						'base' => $langCode,
						'fallbacks' => $fallbacks,
					];
				}
			}
		}
		return $this->variants;
	}

	public function widthOption(): int {
		return $this->config->get( 'ThumbLimits' )[User::getDefaultOption( 'thumbsize' )];
	}

	private function populateMagicWords(): void {
		if ( $this->magicWords === null ) {
			$this->magicWords = [];
			$this->mwAliases = [];

			foreach (
				MediaWikiServices::getInstance()->getContentLanguage()->getMagicWords()
				as $magicword => $aliases
			) {
				$caseSensitive = array_shift( $aliases );
				foreach ( $aliases as $alias ) {
					$this->mwAliases[$magicword][] = $alias;
					if ( !$caseSensitive ) {
						$alias = mb_strtolower( $alias );
						$this->mwAliases[$magicword][] = $alias;
					}
					$this->magicWords[$alias] = $magicword;
				}
			}
		}
	}

	public function magicWords(): array {
		$this->populateMagicWords();
		return $this->magicWords;
	}

	public function mwAliases(): array {
		$this->populateMagicWords();
		return $this->mwAliases;
	}

	public function getMagicWordMatcher( string $id ): string {
		return MediaWikiServices::getInstance()->getMagicWordFactory()
			->get( $id )->getRegexStartToEnd();
	}

	/** @inheritDoc */
	public function getMagicPatternMatcher( array $words ): callable {
		$words = MediaWikiServices::getInstance()->getMagicWordFactory()
			->newArray( $words );
		return function ( $text ) use ( $words ) {
			$ret = $words->matchVariableStartToEnd( $text );
			if ( $ret[0] === false ) {
				return null;
			} else {
				return [ 'k' => $ret[0], 'v' => $ret[1] ];
			}
		};
	}

	private function populateExtensionTags(): void {
		$parser = MediaWikiServices::getInstance()->getParser();
		$this->extensionTags = array_fill_keys( $parser->getTags(), true );
	}

	public function isExtensionTag( $name ): bool {
		if ( $this->extensionTags === null ) {
			$this->populateExtensionTags();
		}
		return isset( $this->extensionTags[$name] );
	}

	public function getExtensionTagNameMap(): array {
		if ( $this->extensionTags === null ) {
			$this->populateExtensionTags();
		}
		return $this->extensionTags;
	}

	public function getMaxTemplateDepth(): int {
		return (int)$this->config->get( 'MaxTemplateDepth' );
	}

	/** @inheritDoc */
	public function getExtResourceURLPatternMatcher(): callable {
		$nsAliases = [
			'Special',
			$this->quoteTitleRe( $this->contLang->getNsText( NS_SPECIAL ) )
		];
		foreach (
			array_merge( $this->config->get( 'NamespaceAliases' ), $this->contLang->getNamespaceAliases() )
			as $name => $ns
		) {
			if ( $ns === NS_SPECIAL ) {
				$nsAliases[] = $this->quoteTitleRe( $name );
			}
		}
		$nsAliases = implode( '|', array_unique( $nsAliases ) );

		$pageAliases = implode( '|', array_map( [ $this, 'quoteTitleRe' ], array_merge(
			[ 'Booksources' ],
			$this->contLang->getSpecialPageAliases()['Booksources'] ?? []
		) ) );

		// cscott wants a mention of T145590 here ("Update Parsoid to be compatible with magic links
		// being disabled")
		$pats = [
			'ISBN' => '(?:\.\.?/)*(?i:' . $nsAliases . ')(?:%3[Aa]|:)'
				. '(?i:' . $pageAliases . ')(?:%2[Ff]|/)(?P<ISBN>\d+[Xx]?)',
			'RFC' => '[^/]*//tools\.ietf\.org/html/rfc(?P<RFC>\w+)',
			'PMID' => '[^/]*//www\.ncbi\.nlm\.nih\.gov/pubmed/(?P<PMID>\w+)\?dopt=Abstract',
		];
		$regex = '!^(?:' . implode( '|', $pats ) . ')$!';
		return function ( $text ) use ( $pats, $regex ) {
			if ( preg_match( $regex, $text, $m ) ) {
				foreach ( $pats as $k => $re ) {
					if ( isset( $m[$k] ) && $m[$k] !== '' ) {
						return [ $k, $m[$k] ];
					}
				}
			}
			return false;
		};
	}

	/** @inheritDoc */
	public function hasValidProtocol( string $potentialLink ): bool {
		$protocols = $this->config->get( 'UrlProtocols' );
		$regex = '!^(?:' . implode( '|', array_map( 'preg_quote', $protocols ) ) . ')!i';
		return (bool)preg_match( $regex, $potentialLink );
	}

	/** @inheritDoc */
	public function findValidProtocol( string $potentialLink ): bool {
		$protocols = $this->config->get( 'UrlProtocols' );
		$regex = '!(?:\W|^)(?:' . implode( '|', array_map( 'preg_quote', $protocols ) ) . ')!i';
		return (bool)preg_match( $regex, $potentialLink );
	}

}
