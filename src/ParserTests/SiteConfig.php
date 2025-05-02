<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\ParserTests;

use Monolog\Handler\FilterHandler;
use Monolog\Logger;
use Psr\Log\LoggerInterface;
use Wikimedia\Assert\Assert;
use Wikimedia\Parsoid\Config\Api\ApiHelper;
use Wikimedia\Parsoid\Config\Api\SiteConfig as ApiSiteConfig;
use Wikimedia\Parsoid\Ext\ExtensionModule;
use Wikimedia\Parsoid\Utils\ConfigUtils;
use Wikimedia\Parsoid\Utils\Utils;

class SiteConfig extends ApiSiteConfig {
	/** @var array overrides parent-class info */
	private $interwikiMap;

	/** @var bool overrides parent-class info */
	private $interwikiMagic;

	/** @var array<string,bool> overrides parent-class info */
	private $enabledMagicLinks = [];

	/** @var array overrides parent-class server info */
	private $serverData;

	/** @var array overrides parent-class info */
	public $allowedExternalImagePrefixes = [ '' ];

	/**
	 * Init to default value for parserTests. Overrides parent-class info.
	 * @var array
	 */
	public $responsiveReferences;

	/** @var ?int */
	public $thumbsize;

	/** @var LoggerInterface */
	public $suppressLogger;

	/** If set, generate experimental Parsoid HTML v3 parser function output
	 * Individual parser tests could change this
	 */
	public bool $v3pf;

	/** @var string|false */
	private $externalLinkTarget = false;

	/** @var ?array */
	private $noFollowConfig;

	/** @inheritDoc */
	public function __construct( ApiHelper $api, array $opts ) {
		$logger = self::createLogger();
		$opts['logger'] = $logger;
		parent::__construct( $api, $opts );

		// Needed for bidi-char-scrubbing html2wt tests.
		$this->scrubBidiChars = true;

		// Logger to suppress all logs but fatals (critical errors)
		$this->suppressLogger = new Logger( "ParserTests" );
		$errorLogHandler = $logger->getHandlers()[0];
		$filterHandler = new FilterHandler( $errorLogHandler, Logger::CRITICAL );
		$this->suppressLogger->pushHandler( $filterHandler );
	}

	/** @inheritDoc */
	protected function getCustomSiteConfigFileName(): string {
		return ParserHook::getParserTestConfigFileName();
	}

	public function reset() {
		parent::reset();

		// adjust config to match that used for PHP tests
		// see core/tests/parser/parserTest.inc:setupGlobals() for
		// full set of config normalizations done.
		$this->serverData = [
			'server'      => 'http://example.org',
			'scriptpath'  => '/',
			'script'      => '/index.php',
			'articlepath' => '/wiki/$1',
			'baseURI'     => 'http://example.org/wiki/'
		];

		// Add 'MemoryAlpha' namespace (T53680)
		$this->updateNamespace( [
			'id' => 100,
			'case' => 'first-letter',
			'subpages' => false,
			'canonical' => 'MemoryAlpha',
			'name' => 'MemoryAlpha',
		] );

		// Testing
		if ( $this->iwp() === 'enwiki' ) {
			$this->updateNamespace( [
				'id' => 4,
				'case' => 'first-letter',
				'subpages' => true,
				'canonical' => 'Project',
				'name' => 'Base MW'
			] );
			$this->updateNamespace( [
				'id' => 5,
				'case' => 'first-letter',
				'subpages' => true,
				'canonical' => 'Project talk',
				'name' => 'Base MW talk'
			] );
		}

		// Reset other values to defaults
		$this->responsiveReferences = [ 'enabled' => true, 'threshold' => 10 ];
		$this->disableSubpagesForNS( 0 );
		$this->thumbsize = null;
		$this->externalLinkTarget = false;
		$this->noFollowConfig = null;
		$this->v3pf = false;
	}

	private function deleteNamespace( string $name ): void {
		$normName = Utils::normalizeNamespaceName( $name );
		$id = $this->namespaceId( $normName );

		if ( !$id ) {
			$normName = $name;
			$id = $this->namespaceId( $normName );
		}

		if ( $id ) {
			unset( $this->nsCanon[$normName] );
			unset( $this->nsIds[$normName] );
			unset( $this->nsNames[$id] );
			unset( $this->nsCase[$id] );
			unset( $this->nsWithSubpages[$id] );
		}
	}

	public function disableSubpagesForNS( int $ns ): void {
		$this->nsWithSubpages[$ns] = false;
	}

	public function enableSubpagesForNS( int $ns ): void {
		$this->nsWithSubpages[$ns] = true;
	}

	/**
	 * Update namespace info.
	 *
	 * Delete any existing namespace with the same id.
	 * Add new namespaces.
	 *
	 * @param array $ns
	 */
	private function updateNamespace( array $ns ): void {
		$old = $this->namespaceName( (int)$ns['id'] );
		if ( $old ) { // Id may already be defined; if so, clear it.
			if ( $old === Utils::normalizeNamespaceName( $ns['name'] ) ) {
				// ParserTests does a lot redundantly.
				return;
			}
			$this->deleteNamespace( $old );
		}
		$this->addNamespace( $ns );
		Assert::invariant( $ns['case'] === 'first-letter',
			'ParserTests/SiteConfig only supports first-letter case currently' );
	}

	/**
	 * Compute the interwiki map based on mock raw data.
	 * This replaces the previously computed interwiki map
	 * based on data from MockApiHelper
	 *
	 * @param array $iwData
	 */
	public function setupInterwikiMap( array $iwData ): void {
		$this->interwikiMap = ConfigUtils::computeInterwikiMap( $iwData );
		$this->interwikiMapNoNamespaces = null;
		$this->iwMatcher = null;
	}

	public function interwikiMap(): array {
		return $this->interwikiMap;
	}

	public function server(): string {
		return $this->serverData['server'];
	}

	public function script(): string {
		return $this->serverData['script'];
	}

	public function scriptpath(): string {
		return $this->serverData['scriptpath'];
	}

	public function baseURI(): string {
		return $this->serverData['baseURI'];
	}

	public function allowedExternalImagePrefixes(): array {
		return $this->allowedExternalImagePrefixes;
	}

	/** @inheritDoc */
	public function getMWConfigValue( string $key ) {
		switch ( $key ) {
			case 'CiteResponsiveReferences':
				return $this->responsiveReferences['enabled'];

			case 'CiteResponsiveReferencesThreshold':
				return $this->responsiveReferences['threshold'];

			case 'ParsoidExperimentalParserFunctionOutput':
				return $this->v3pf;

			default:
				return null;
		}
	}

	public function setInterwikiMagic( bool $val ): void {
		$this->interwikiMagic = $val;
	}

	public function interwikiMagic(): bool {
		return $this->interwikiMagic;
	}

	/**
	 * @param string $which One of "RFC", "PMID", or "ISBN".
	 * @param bool $val
	 */
	public function setMagicLinkEnabled( string $which, bool $val ): void {
		$this->enabledMagicLinks[$which] = $val;
	}

	public function magicLinkEnabled( string $which ): bool {
		// defaults to enabled
		return $this->enabledMagicLinks[$which] ?? true;
	}

	public function fakeTimestamp(): ?int {
		return 123;
	}

	/**
	 * Hardcode value for parser tests
	 *
	 * @return int
	 */
	public function timezoneOffset(): int {
		return 0;
	}

	public function widthOption(): int {
		return $this->thumbsize ?? 180;  // wgThumbLimits setting in core ParserTestRunner
	}

	/**
	 * Register an extension for use in parser tests
	 * @param class-string<ExtensionModule> $extClass
	 * @return callable a cleanup function to unregister this extension
	 */
	public function registerParserTestExtension( string $extClass ): callable {
		$extId = $this->registerExtensionModule( $extClass );
		return function () use ( $extId ) {
			$this->unregisterExtensionModule( $extId );
		};
	}

	/**
	 * @param string|false $value
	 */
	public function setExternalLinkTarget( $value ): void {
		$this->externalLinkTarget = $value;
	}

	/**
	 * @inheritDoc
	 */
	public function getExternalLinkTarget() {
		return $this->externalLinkTarget;
	}

	/**
	 * @param string $key
	 * @param mixed $value
	 */
	public function setNoFollowConfig( string $key, $value ): void {
		$noFollowConfig = $this->getNoFollowConfig();
		$noFollowConfig[$key] = $value;
		$this->noFollowConfig = $noFollowConfig;
	}

	/**
	 * @inheritDoc
	 */
	public function getNoFollowConfig(): array {
		if ( $this->noFollowConfig === null ) {
			$this->noFollowConfig = parent::getNoFollowConfig();
		}
		return $this->noFollowConfig;
	}
}
