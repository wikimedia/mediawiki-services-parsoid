<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Tools;

require_once __DIR__ . '/../tools/Maintenance.php';

use ExcimerProfiler;
use MediaWiki\Content\WikitextContent;
use MediaWiki\MediaWikiServices;
use MediaWiki\Parser\ParserOptions;
use MediaWiki\Revision\MutableRevisionRecord;
use MediaWiki\Revision\SlotRecord;
use MediaWiki\Title\Title as MWTitle;
use Wikimedia\JsonCodec\JsonCodec;
use Wikimedia\Parsoid\Config\Api\ApiHelper;
use Wikimedia\Parsoid\Config\Api\DataAccess;
use Wikimedia\Parsoid\Config\Api\PageConfig;
use Wikimedia\Parsoid\Config\Api\SiteConfig;
use Wikimedia\Parsoid\Config\SiteConfig as ISiteConfig;
use Wikimedia\Parsoid\Config\StubMetadataCollector;
use Wikimedia\Parsoid\Core\BasePageBundle;
use Wikimedia\Parsoid\Core\ClientError;
use Wikimedia\Parsoid\Core\ContentMetadataCollector;
use Wikimedia\Parsoid\Core\HtmlPageBundle;
use Wikimedia\Parsoid\Core\SelectiveUpdateData;
use Wikimedia\Parsoid\Mocks\MockDataAccess;
use Wikimedia\Parsoid\Mocks\MockPageConfig;
use Wikimedia\Parsoid\Mocks\MockPageContent;
use Wikimedia\Parsoid\Mocks\MockSiteConfig;
use Wikimedia\Parsoid\ParserTests\DummyAnnotation;
use Wikimedia\Parsoid\ParserTests\TestUtils;
use Wikimedia\Parsoid\Parsoid;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Utils\Title as ParsoidTitle;

abstract class ParseUtils extends Maintenance {
	use ExtendedOptsProcessor;

	/** @var ISiteConfig */
	protected $siteConfig;

	/** @var PageConfig */
	protected $pageConfig;

	/** @var ContentMetadataCollector */
	protected $metadata;

	/** @var Parsoid */
	protected $parsoid;

	private function setupMwConfig( array $configOpts ): void {
		$services = MediaWikiServices::getInstance();
		$siteConfig = $services->getParsoidSiteConfig();
		// Overwriting logger so that it logs to console/file
		$logFilePath = 'php://stderr';
		if ( $this->hasOption( 'logFile' ) ) {
			$logFilePath = $this->getOption( 'logFile' );
		}
		$siteConfig->setLogger( SiteConfig::createLogger( $logFilePath ) );

		if ( isset( $configOpts['maxDepth'] ) ) {
			$siteConfig->setMaxTemplateDepth( $configOpts['maxDepth'] );
		}
		$dataAccess = $services->getParsoidDataAccess();
		$pcFactory = $services->getParsoidPageConfigFactory();
		// XXX we're ignoring 'pageLanguage' & 'pageLanguageDir' in $configOpts
		$title = isset( $configOpts['title'] )
			? MWTitle::newFromText( $configOpts['title'] )
			: $siteConfig->mainPageLinkTarget();

		$wikitextOverride = $configOpts['pageContent'] ?? null;
		$revision = $configOpts['revid'] ?? null;
		if ( $wikitextOverride === null ) {
			$revisionRecord = null;
		} else {
			// Create a mutable revision record point to the same revision
			// and set to the desired wikitext.
			$revisionRecord = new MutableRevisionRecord( $title );
			if ( $revision !== null ) {
				$revisionRecord->setId( $revision );
			}
			$revisionRecord->setSlot(
				SlotRecord::newUnsaved(
					SlotRecord::MAIN,
					new WikitextContent( $wikitextOverride )
				)
			);
		}

		$this->siteConfig = $siteConfig;
		$this->pageConfig = $pcFactory->createFromParserOptions(
			ParserOptions::newFromAnon(),
			$title,
			$revisionRecord ?? $revision,
			null,
			$configOpts['ensureAccessibleContent']
		);
		$this->metadata = new \ParserOutput();
		$this->parsoid = new Parsoid( $siteConfig, $dataAccess );
	}

	private function setupApiConfig( array $configOpts ): void {
		$api = new ApiHelper( $configOpts );

		$siteConfig = new SiteConfig( $api, $configOpts );
		$logFilePath = 'php://stderr';
		if ( $this->hasOption( 'logFile' ) ) {
			$logFilePath = $this->getOption( 'logFile' );
		}
		$siteConfig->setLogger( SiteConfig::createLogger( $logFilePath ) );
		$dataAccess = new DataAccess( $api, $siteConfig, $configOpts );
		$this->siteConfig = $siteConfig;
		$configOpts['title'] = isset( $configOpts['title'] )
			? ParsoidTitle::newFromText( $configOpts['title'], $siteConfig )
			: $siteConfig->mainPageLinkTarget();

		$this->pageConfig = new PageConfig( $api, $siteConfig, $configOpts + [
				'loadData' => true
			] );

		if ( $configOpts['ensureAccessibleContent'] ) {
			try {
				$this->pageConfig->getPageMainContent();
			} catch ( \Error $e ) {
				throw new \RuntimeException( 'The specified revision does not exist.' );
			}
		}

		$this->metadata = new StubMetadataCollector( $siteConfig );
		$this->parsoid = new Parsoid( $siteConfig, $dataAccess );
	}

	private function setupMockConfig( array $configOpts ): void {
		$siteConfig = new MockSiteConfig( $configOpts );
		$siteConfig->registerExtensionModule( DummyAnnotation::class );
		$dataAccess = new MockDataAccess( $siteConfig, $configOpts );
		$pageContent = new MockPageContent( [ 'main' =>
			$configOpts['pageContent'] ?? '' ] );
		$this->siteConfig = $siteConfig;
		$this->pageConfig = new MockPageConfig( $siteConfig, $configOpts, $pageContent );
		$this->metadata = new StubMetadataCollector( $siteConfig );
		$this->parsoid = new Parsoid( $siteConfig, $dataAccess );
	}

	/**
	 * Initialize $this->parsoid and $this->pageConfig
	 *
	 * @param array $configOpts
	 */
	protected function setupConfig( array $configOpts ) {
		if ( $configOpts['mock'] ) {
			$this->setupMockConfig( $configOpts );
		} elseif ( $configOpts['standalone'] ?? true ) {
			$this->setupApiConfig( $configOpts );
		} else {
			$this->setupMwConfig( $configOpts );
		}
	}

	/**
	 * @param array $configOpts
	 * @param array $parsoidOpts
	 * @param ?string $wt
	 * @param ?SelectiveUpdateData $selparData
	 * @return string|HtmlPageBundle
	 */
	public function wt2Html(
		array $configOpts, array $parsoidOpts, ?string $wt,
		?SelectiveUpdateData $selparData = null
	) {
		if ( $wt !== null ) {
			$configOpts["pageContent"] = $wt;
		}
		$this->setupConfig( $configOpts );

		try {
			return $this->parsoid->wikitext2html(
				$this->pageConfig, $parsoidOpts, $headers, $this->metadata, $selparData
			);
		} catch ( ClientError $e ) {
			$this->error( $e->getMessage() );
			die( 1 );
		}
	}

	/**
	 * @param array $configOpts
	 * @param array $parsoidOpts
	 * @param ?string $wt
	 * @return string
	 */
	public function wt2lint(
		array $configOpts, array $parsoidOpts, ?string $wt
	) {
		if ( $wt !== null ) {
			$configOpts["pageContent"] = $wt;
		}
		$this->setupConfig( $configOpts );

		try {
			$lints = $this->parsoid->wikitext2lint(
				$this->pageConfig, $parsoidOpts
			);
			$lintStr = '';
			foreach ( $lints as $l ) {
				$lintStr .= PHPUtils::jsonEncode( $l ) . "\n";
			}
			return $lintStr;
		} catch ( ClientError $e ) {
			$this->error( $e->getMessage() );
			die( 1 );
		}
	}

	public function html2Wt(
		array $configOpts, array $parsoidOpts, string|HtmlPageBundle $html,
		?SelectiveUpdateData $selserData = null
	): string {
		$configOpts["pageContent"] = $selserData->revText ?? ''; // FIXME: T234549
		$this->setupConfig( $configOpts );

		try {
			if ( $html instanceof HtmlPageBundle ) {
				return $this->parsoid->dom2wikitext(
					$this->pageConfig, $html, $parsoidOpts, $selserData
				);
			}
			return $this->parsoid->html2wikitext(
				$this->pageConfig, $html, $parsoidOpts, $selserData
			);
		} catch ( ClientError $e ) {
			$this->error( $e->getMessage() );
			die( 1 );
		}
	}

	private function maybeNormalize( string $html ): string {
		if ( $this->hasOption( 'normalize' ) ) {
			$html = TestUtils::normalizeOut(
				$html, [
					'parsoidOnly' => $this->getOption( 'normalize' ) === 'parsoid',
				]
			);
		}
		return $html;
	}

	/**
	 * Produce a CPU flamegraph via excimer's profiling
	 */
	protected function startFlameGraphProfiler() {
		$profiler = new ExcimerProfiler;
		$profiler->setPeriod( 0.00001 );
		$profiler->setEventType( EXCIMER_REAL );
		$profiler->start();
		register_shutdown_function( static function () use ( $profiler ) {
			$profiler->stop();
			$fgPath = getenv( 'FLAMEGRAPH_PATH' ) ?: '/usr/local/bin/flamegraph.pl';
			$fgOutDir = getenv( 'FLAMEGRAPH_OUTDIR' ) ?: '/tmp';
			// phpcs:disable MediaWiki.Usage.ForbiddenFunctions.popen
			$pipe = popen( "$fgPath > $fgOutDir/profile.svg", "w" );
			fwrite( $pipe, $profiler->getLog()->formatCollapsed() );
			$report = sprintf( "%-79s %14s %14s\n", 'Function', 'Self', 'Inclusive' );
			foreach ( $profiler->getLog()->aggregateByFunction() as $id => $info ) {
				$report .= sprintf( "%-79s %14d %14d\n", $id, $info['self'], $info['inclusive'] );
			}
			file_put_contents( "$fgOutDir/aggregated.txt", $report );
		} );
	}

	/**
	 * Optionally benchmark a callback. If benchmarking is disabled, just call
	 * it and output the return value.
	 *
	 * @param callable $callback
	 */
	private function benchmark( $callback ) {
		if ( $this->hasOption( 'warmup' ) ) {
			$callback();
		}
		if ( $this->hasOption( 'benchmark' ) ) {
			$count = $this->getOption( 'count', 1 );
			if ( $this->hasOption( 'delay' ) ) {
				usleep( $this->getOption( 'delay' ) * 1000 );
			}
			$startTime = hrtime( true );
			for ( $i = 0; $i < $count; $i++ ) {
				$callback();
			}
			$total = ( hrtime( true ) - $startTime ) / 1000000;
			$this->output( "Total time: $total ms\n" );
			if ( $count > 1 ) {
				$mean = $total / $count;
				$this->output( "Mean: $mean ms\n" );
			}
			$this->output( sprintf( "Peak memory usage: %.2f MiB\n",
				memory_get_peak_usage() / 1048576 ) );
		} else {
			$this->output( $callback() );
			if ( self::posix_isatty( STDOUT ) ) {
				$this->output( "\n" );
			}
		}
	}

	private function setupSelectiveUpdateData( ?string $mode = null ): ?SelectiveUpdateData {
		if ( $this->hasOption( 'revtextfile' ) ) {
			$revText = file_get_contents( $this->getOption( 'revtextfile' ) );
			if ( $revText === false ) {
				return null;
			}
		} else {
			$this->error(
				'Please provide original wikitext via --revtextfile. ' .
				'Selective Serialization needs it.'
			);
			$this->maybeHelp();
			return null;
		}
		$revHTML = null;
		if ( $this->hasOption( 'revhtmlfile' ) ) {
			$revHTML = file_get_contents( $this->getOption( 'revhtmlfile' ) );
			if ( $revHTML === false ) {
				return null;
			}
			$revHTML = $this->getPageBundleXML( $revHTML ) ?? $revHTML;
		}
		if ( $this->hasOption( 'selser' ) ) {
			return new SelectiveUpdateData( $revText, $revHTML );
		} elseif ( $this->hasOption( 'selpar' ) ) {
			$revData = new SelectiveUpdateData( $revText, $revHTML, $mode );
			$revData->templateTitle = $this->getOption( 'editedtemplatetitle' );
			if ( !$revData->templateTitle ) {
				$this->error(
					'Please provide title of the edited template. ' .
					'Selective Parsing (which right now defaults to template edits only) needs it.'
				);
				$this->maybeHelp();
				return null;
			}
			return $revData;
		}
	}

	/**
	 * Do html2wt or html2html and output the result
	 *
	 * @param array $configOpts
	 * @param array $parsoidOpts
	 * @param string $input
	 */
	protected function transformFromHtml( $configOpts, $parsoidOpts, $input ) {
		$this->setupConfig( $configOpts );
		$input = $this->getPageBundleXML( $input ) ?? $input;

		if ( $this->hasOption( 'selser' ) ) {
			$selserData = $this->setupSelectiveUpdateData();
			if ( $selserData === null ) {
				return;
			}
		} else {
			$selserData = null;
		}

		if ( $this->hasOption( 'html2html' ) ) {
			$this->benchmark(
				function () use ( $configOpts, $parsoidOpts, $input, $selserData ) {
					$wt = $this->html2Wt( $configOpts, $parsoidOpts, $input, $selserData );
					$html = $this->wt2Html( $configOpts, $parsoidOpts, $wt );
					return $this->maybeNormalize( $html );
				}
			);
		} else {
			$this->benchmark(
				function () use ( $configOpts, $parsoidOpts, $input, $selserData ) {
					return $this->html2Wt( $configOpts, $parsoidOpts, $input, $selserData );
				}
			);
		}
	}

	/**
	 * Get the page bundle XML, or null if pbin/pbinfile was not specified
	 *
	 * @param string $input
	 * @return string|null
	 * @throws ClientError
	 */
	private function getPageBundleXML( $input ) {
		if ( !$this->hasOption( 'pbin' ) && !$this->hasOption( 'pbinfile' ) ) {
			return null;
		}
		if ( $this->hasOption( 'pbinfile' ) ) {
			$json = file_get_contents( $this->getOption( 'pbinfile' ) );
		} else {
			$json = $this->getOption( 'pbin' );
		}
		$pb = ( new JsonCodec )->newFromJsonString( $json, BasePageBundle::class );
		$pb->mw ??= [ 'ids' => [] ];  // FIXME: ^999.0.0
		$pb = $pb->withHtml( $input );
		return $pb->toInlineAttributeHtml( siteConfig: $this->siteConfig );
	}

	/**
	 * Do a wt2html or wt2wt operation and output the result
	 *
	 * @param array $configOpts
	 * @param array $parsoidOpts
	 * @param string $input
	 */
	protected function transformFromWt( $configOpts, $parsoidOpts, $input ) {
		if ( $this->hasOption( 'selpar' ) ) {
			$this->setupConfig( $configOpts );
			$selparData = $this->setupSelectiveUpdateData( 'template' );
			if ( $selparData === null ) {
				return;
			}
			$this->benchmark( function () use ( $configOpts, $parsoidOpts, $input, $selparData ) {
				return $this->wt2Html( $configOpts, $parsoidOpts, $input, $selparData );
			} );
		} elseif ( $this->hasOption( 'wt2wt' ) ) {
			$this->benchmark( function () use ( $configOpts, $parsoidOpts, $input ) {
				$html = $this->wt2Html( $configOpts, $parsoidOpts, $input );
				return $this->html2Wt( $configOpts, $parsoidOpts, $html );
			} );
		} elseif ( $this->hasOption( 'wt2lint' ) ) {
			$this->output( $this->wt2Lint( $configOpts, $parsoidOpts, $input ) );
		} elseif ( $parsoidOpts['pageBundle'] ?? false ) {
			if ( $this->hasOption( 'pboutfile' ) ) {
				$pb = $this->wt2Html( $configOpts, $parsoidOpts, $input );
				file_put_contents(
					$this->getOption( 'pboutfile' ),
					( new JsonCodec )->toJsonString(
						$pb->toBasePageBundle(),
						BasePageBundle::class
					)
				);
				$html = $pb->html;
			} elseif ( $this->hasOption( 'pageBundle' ) ) {
				$pb = $this->wt2Html( $configOpts, $parsoidOpts, $input );
				// Stitch this back in, even though it was just extracted
				$html = $pb->toSingleDocumentHtml();
			}
			$this->output( $this->maybeNormalize( $html ) );
		} else {
			$this->benchmark( function () use ( $configOpts, $parsoidOpts, $input ) {
				$html = $this->wt2Html( $configOpts, $parsoidOpts, $input );
				return $this->maybeNormalize( $html );
			} );
		}
	}
}
