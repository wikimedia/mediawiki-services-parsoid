<?php

namespace Parsoid\Tests;

use Parsoid\Config\SiteConfig;
use Parsoid\Utils\PHPUtils;
use Parsoid\Utils\Util;
use Psr\Log\AbstractLogger;
use Psr\Log\LoggerInterface;

class MockSiteConfig extends SiteConfig {

	/** @var int Unix timestamp */
	private $fakeTimestamp = 946782245; // 2000-01-02T03:04:05Z

	/** @var int */
	private $timezoneOffset = 0; // UTC

	/** @var bool */
	private $interwikiMagic = true;

	/** @var int|null */
	private $tidyWhitespaceBugMaxLength = null;

	protected $namespaceMap = [
		'media' => -2,
		'special' => -1,
		'' => 0,
		'talk' => 1,
		'user' => 2,
		'user_talk' => 3,
		// Last one will be used by namespaceName
		'project' => 4, 'wp' => 4, 'wikipedia' => 4,
		'project_talk' => 5, 'wt' => 5, 'wikipedia_talk' => 5,
		'file' => 6,
		'file_talk' => 7,
		'category' => 14,
		'category_talk' => 15,
	];

	/** @var array<int, bool> */
	protected $namespacesWithSubpages = [];

	/** @var array */
	protected $interwikiMap = [];

	/**
	 * @param array $opts
	 */
	public function __construct( array $opts ) {
		parent::__construct();

		if ( isset( $opts['rtTestMode'] ) ) {
			$this->rtTestMode = !empty( $opts['rtTestMode'] );
		}

		$this->tidyWhitespaceBugMaxLength = $opts['tidyWhitespaceBugMaxLength'] ?? null;

		if ( isset( $opts['linkPrefixRegex'] ) ) {
			$this->linkPrefixRegex = $opts['linkPrefixRegex'];
		}
		if ( isset( $opts['linkTrailRegex'] ) ) {
			$this->linkTrailRegex = $opts['linkTrailRegex'];
		}
		if ( !empty( $opts['traceFlags'] ) ||
			!empty( $opts['dumpFlags'] ) ||
			!empty( $opts['debugFlags'] )
		) {
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
	 * Set the log channel, for debugging
	 * @param LoggerInterface|null $logger
	 */
	public function setLogger( ?LoggerInterface $logger ): void {
		$this->logger = $logger;
	}

	public function tidyWhitespaceBugMaxLength(): int {
		return $this->tidyWhitespaceBugMaxLength ?? parent::tidyWhitespaceBugMaxLength();
	}

	public function allowedExternalImagePrefixes(): array {
		return [];
	}

	public function baseURI(): string {
		return '//my.wiki.example/wikix/';
	}

	public function bswPagePropRegexp(): string {
		return '/(?:^|\\s)mw:PageProp\/(?:' .
				'NOGLOBAL|DISAMBIG|NOCOLLABORATIONHUBTOC|nocollaborationhubtoc|NOTOC|notoc|' .
				'NOGALLERY|nogallery|FORCETOC|forcetoc|TOC|toc|NOEDITSECTION|noeditsection|' .
				'NOTITLECONVERT|notitleconvert|NOTC|notc|NOCONTENTCONVERT|nocontentconvert|' .
				'NOCC|nocc|NEWSECTIONLINK|NONEWSECTIONLINK|HIDDENCAT|INDEX|NOINDEX|STATICREDIRECT' .
			')(?=$|\\s)/';
	}

	/** @inheritDoc */
	public function canonicalNamespaceId( string $name ): ?int {
		return $this->namespaceMap[$name] ?? null;
	}

	/** @inheritDoc */
	public function namespaceId( string $name ): ?int {
		$name = Util::normalizeNamespaceName( $name );
		return $this->namespaceMap[$name] ?? null;
	}

	/** @inheritDoc */
	public function namespaceName( int $ns ): ?string {
		static $map = null;
		if ( $map === null ) {
			$map = array_flip( $this->namespaceMap );
		}
		if ( !isset( $map[$ns] ) ) {
			return null;
		}
		return ucwords( strtr( $map[$ns], '_', ' ' ) );
	}

	/** @inheritDoc */
	public function namespaceHasSubpages( int $ns ): bool {
		return !empty( $this->namespacesWithSubpages[$ns] );
	}

	/** @inheritDoc */
	public function namespaceCase( int $ns ): string {
		return 'first-letter';
	}

	/** @inheritDoc */
	public function specialPageLocalName( string $alias ): ?string {
		throw new \BadMethodCallException( 'Not implemented' );
	}

	public function setInterwikiMagic( bool $val ) {
		$this->interwikiMagic = $val;
	}

	public function interwikiMagic(): bool {
		return $this->interwikiMagic;
	}

	public function interwikiMap(): array {
		return $this->interwikiMap;
	}

	public function iwp(): string {
		return 'mywiki';
	}

	public function legalTitleChars() : string {
		return ' %!"$&\'()*,\-.\/0-9:;=?@A-Z\\\\^_`a-z~\x80-\xFF+';
	}

	private $linkPrefixRegex = null;

	public function linkPrefixRegex(): ?string {
		return $this->linkPrefixRegex;
	}

	private $linkTrailRegex = '/^([a-z]+)/sD'; // enwiki default
	public function linkTrailRegex(): ?string {
		return $this->linkTrailRegex;
	}

	public function lang(): string {
		return 'en';
	}

	public function mainpage(): string {
		return 'Main Page';
	}

	public function responsiveReferences(): array {
		throw new \BadMethodCallException( 'Not implemented' );
	}

	public function rtl(): bool {
		return false;
	}

	/** @inheritDoc */
	public function langConverterEnabled( string $lang ): bool {
		return true;
	}

	public function script(): string {
		return '/wx/index.php';
	}

	public function scriptpath(): string {
		return '/wx';
	}

	public function server(): string {
		return '//my.wiki.example';
	}

	public function solTransparentWikitextRegexp(): string {
		throw new \BadMethodCallException( 'Not implemented' );
	}

	public function solTransparentWikitextNoWsRegexp(): string {
		throw new \BadMethodCallException( 'Not implemented' );
	}

	public function timezoneOffset(): int {
		return $this->timezoneOffset;
	}

	public function variants(): array {
		throw new \BadMethodCallException( 'Not implemented' );
	}

	public function widthOption(): int {
		return 220;
	}

	public function magicWords(): array {
		return [ 'toc' => 'toc' ];
	}

	public function mwAliases(): array {
		return [ 'toc' => [ 'toc' ] ];
	}

	public function getMagicWordMatcher( string $id ): string {
		if ( $id === 'toc' ) {
			return '/^TOC$/';
		} else {
			return '/(?!)/';
		}
	}

	/** @inheritDoc */
	public function getParameterizedAliasMatcher( array $words ): callable {
		throw new \BadMethodCallException( 'Not implemented' );
	}

	/** @inheritDoc */
	protected function getNonNativeExtensionTags(): array {
		return [
			'gallery' => true,    // Remove when gallery is ported
			'poem' => true,       // Remove when poem is ported
			'indicator' => true,
			'timeline' => true,
			'hiero' => true,
			'charinsert' => true,
			'inputbox' => true,
			'imagemap' => true,
			'source' => true,
			'syntaxhighlight' => true,
			'section' => true,
			'score' => true,
			'templatedata' => true,
			'math' => true,
			'ce' => true,
			'chem' => true,
			'graph' => true,
			'maplink' => true,
			'categorytree' => true,
		];
	}

	public function getMaxTemplateDepth(): int {
		return 40;
	}

	/** @inheritDoc */
	public function getExtResourceURLPatternMatcher(): callable {
		throw new \BadMethodCallException( 'Not implemented' );
	}

	/** @inheritDoc */
	public function hasValidProtocol( string $potentialLink ): bool {
		return preg_match( '#^((https?|ircs?|news|ftp|mailto|gopher):|//)#', $potentialLink );
	}

	/** @inheritDoc */
	public function findValidProtocol( string $potentialLink ): bool {
		return preg_match( '#(?:\W|^)((https?|ircs?|news|ftp|mailto|gopher):|//)#', $potentialLink );
	}

	public function fakeTimestamp(): ?int {
		return $this->fakeTimestamp;
	}

	/**
	 * Set the fake timestamp for testing
	 * @param int|null $ts Unix timestamp
	 */
	public function setFakeTimestamp( ?int $ts ): void {
		$this->fakeTimestamp = $ts;
	}

	/**
	 * Set the timezone offset for testing
	 * @param int $offset Offset from UTC
	 */
	public function setTimezoneOffset( int $offset ): void {
		$this->timezoneOffset = $offset;
	}

	public function scrubBidiChars(): bool {
		return true;
	}

	/** @inheritDoc */
	public function getMagicWordForFunctionHook( string $str ): ?string {
		return null;
	}

	/** @inheritDoc */
	public function getMagicWordForVariable( string $str ): ?string {
		return null;
	}
}
