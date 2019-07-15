<?php
declare( strict_types = 1 );

namespace Parsoid\Tests\ParserTests;

use Parsoid\Config\Api\SiteConfig as ApiSiteConfig;
use Parsoid\Utils\ConfigUtils;
use Parsoid\Ext\Extension;
use Parsoid\Utils\Util;
use Wikimedia\Assert\Assert;

class SiteConfig extends ApiSiteConfig {
	/** @var array overrides parent-class info */
	private $interwikiMap;

	/** @var bool overrides parent-class info */
	private $interwikiMagic;

	/** @var array overrides parent-class server info */
	private $serverData;

	/** @var array overrides parent-class info */
	public $allowedExternalImagePrefixes = [ '' ];

	const RESPONSIVE_REFERENCES_DEFAULT = [ 'enabled' => false, 'threshold' => 10 ];

	/**
	 * Init to default value for parserTests. Overrides parent-class info.
	 * @var array
	 */
	public $responsiveReferences;

	public function __construct( $api, array $opts ) {
		parent::__construct( $api, $opts );
	}

	public function reset() {
		parent::reset();
	}

	private function deleteNamespace( string $name ) {
		$normName = Util::normalizeNamespaceName( $name );
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
	 */
	public function updateNamespace( array $ns ): void {
		$old = $this->namespaceName( (int)$ns['id'] );
		if ( $old ) { // Id may already be defined; if so, clear it.
			if ( $old === Util::normalizeNamespaceName( $ns['name'] ) ) {
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
	}

	public function interwikiMap(): array {
		return $this->interwikiMap;
	}

	public function setServerData( array $data ): void {
		$this->serverData = $data;
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

	public function responsiveReferences(): array {
		return $this->responsiveReferences;
	}

	public function setInterwikiMagic( bool $val ) {
		$this->interwikiMagic = $val;
	}

	public function interwikiMagic(): bool {
		return $this->interwikiMagic;
	}

	public function fakeTimestamp(): ?int {
		return 123;
	}

	/** Hardcode value for parser tests */
	public function timezoneOffset(): int {
		return 0;
	}

	/**
	 * Register an extension for use in parser tests
	 * @param Extension $ext
	 */
	public function registerParserTestExtension( Extension $ext ): void {
		$this->registerNativeExtension( $ext );
	}
}
