<?php

namespace Parsoid\Tests;

use Parsoid\Config\SiteConfig;
use Parsoid\Utils\PHPUtils;
use Psr\Log\AbstractLogger;
use Psr\Log\LoggerInterface;

class MockSiteConfig extends SiteConfig {

	/** @var int Unix timestamp */
	private $fakeTimestamp = 946782245; // 2000-01-02T03:04:05Z

	/** @var bool */
	private $rtTestMode = false;

	/**
	 * @param array $opts
	 */
	public function __construct( array $opts ) {
		$this->rtTestMode = !empty( $opts['rtTestMode'] );

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
		throw new \BadMethodCallException( 'Not implemented' );
	}

	/** @inheritDoc */
	public function namespaceId( string $name ): ?int {
		throw new \BadMethodCallException( 'Not implemented' );
	}

	/** @inheritDoc */
	public function namespaceName( int $ns ): ?string {
		throw new \BadMethodCallException( 'Not implemented' );
	}

	/** @inheritDoc */
	public function namespaceHasSubpages( int $ns ): bool {
		throw new \BadMethodCallException( 'Not implemented' );
	}

	public function interwikiMagic(): bool {
		throw new \BadMethodCallException( 'Not implemented' );
	}

	public function interwikiMap(): array {
		throw new \BadMethodCallException( 'Not implemented' );
	}

	public function iwp(): string {
		return 'mywiki';
	}

	public function linkPrefixRegex(): ?string {
		return null;
	}

	public function linkTrailRegex(): ?string {
		return '/^([a-z]+)/sD';
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
		return false;
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
		return 0;
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
	public function getMagicPatternMatcher( array $words ): callable {
		throw new \BadMethodCallException( 'Not implemented' );
	}

	public function getExtensionTagNameMap(): array {
		return [
			'pre' => true,
			'nowiki' => true,
			'gallery' => true,
			'indicator' => true,
			'timeline' => true,
			'hiero' => true,
			'charinsert' => true,
			'ref' => true,
			'references' => true,
			'inputbox' => true,
			'imagemap' => true,
			'source' => true,
			'syntaxhighlight' => true,
			'poem' => true,
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

	public function isExtensionTag( string $name ): bool {
		return isset( $this->getExtensionTagNameMap()[$name] );
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
		throw new \BadMethodCallException( 'Not implemented' );
	}

	/** @inheritDoc */
	public function findValidProtocol( string $potentialLink ): bool {
		throw new \BadMethodCallException( 'Not implemented' );
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

}
