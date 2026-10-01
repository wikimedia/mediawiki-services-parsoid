<?php

/**
 * At present, this script is just used for testing the library and uses a
 * public MediaWiki API, which means it's expected to be slow.
 */

require_once __DIR__ . '/../tools/Maintenance.php';

use MediaWiki\MediaWikiServices;
use MediaWiki\Revision\MutableRevisionRecord;
use MediaWiki\Revision\SlotRecord;
use Wikimedia\Parsoid\Config\Api\ApiHelper;
use Wikimedia\Parsoid\Config\Api\DataAccess;
use Wikimedia\Parsoid\Config\Api\PageConfig;
use Wikimedia\Parsoid\Config\Api\SiteConfig;
use Wikimedia\Parsoid\Config\SiteConfig as ISiteConfig;
use Wikimedia\Parsoid\Config\StubMetadataCollector;
use Wikimedia\Parsoid\Core\ClientError;
use Wikimedia\Parsoid\Core\ContentMetadataCollector;
use Wikimedia\Parsoid\Core\PageBundle;
use Wikimedia\Parsoid\Core\SelectiveUpdateData;
use Wikimedia\Parsoid\Mocks\MockDataAccess;
use Wikimedia\Parsoid\Mocks\MockMetrics;
use Wikimedia\Parsoid\Mocks\MockPageConfig;
use Wikimedia\Parsoid\Mocks\MockPageContent;
use Wikimedia\Parsoid\Mocks\MockSiteConfig;
use Wikimedia\Parsoid\ParserTests\DummyAnnotation;
use Wikimedia\Parsoid\ParserTests\TestUtils;
use Wikimedia\Parsoid\Parsoid;
use Wikimedia\Parsoid\Tools\ExtendedOptsProcessor;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Utils\ScriptUtils;
use Wikimedia\Parsoid\Utils\Title;

// phpcs:ignore MediaWiki.Files.ClassMatchesFilename.WrongCase
class Parse extends \Wikimedia\Parsoid\Tools\Maintenance {
	use ExtendedOptsProcessor;

	/** @var ISiteConfig */
	private $siteConfig;

	/** @var PageConfig */
	private $pageConfig;

	/** @var ContentMetadataCollector */
	private $metadata;

	/** @var Parsoid */
	private $parsoid;

	public function __construct() {
		parent::__construct();
		parent::addDefaultParams();
		$this->addDescription(
			"Omnibus script to convert between wikitext and HTML, and roundtrip wikitext or HTML. "
			. "Supports a number of options pertaining to pointing at a specific wiki "
			. "or enabling various features during these transformations.\n\n"
			. "If no options are provided, --wt2html is enabled by default.\n"
			. "See --help for detailed usage help." );
		$this->addOption( 'wt2html', 'Wikitext -> HTML' );
		$this->addOption( 'wt2lint', 'Wikitext -> Lint.  Enables --linting' );
		$this->addOption( 'html2wt', 'HTML -> Wikitext' );
		$this->addOption( 'wt2wt', 'Wikitext -> Wikitext' );
		$this->addOption( 'html2html', 'HTML -> HTML' );
		$this->addOption(
			'body_only',
			'Just return <body> innerHTML (defaults to true)',
			false,
			true
		);
		$this->setOptionDefault( 'body_only', true );

		$this->addOption( 'profile', 'Proxy for --trace time' );
		$this->addOption( 'benchmark', 'Suppress output and show timing summary' );
		$this->addOption( 'count',
			'Repeat the operation this many times',
			false, true );
		$this->addOption( 'warmup', 'Run the operation once before benchmarking' );
		$this->addOption( 'delay',
			'Wait for the specified number of milliseconds after warmup. For use with perf -D.',
			false, true );

		$this->addOption( 'selser',
						 'Use the selective serializer to go from HTML to Wikitext.' );
		$this->addOption( 'selpar',
						 'In the wt->html direction, update HTML selectively' );
		$this->addOption( 'revtextfile',
						 'File containing revision wikitext for selective html/wikitext updates',
						 false, true );
		$this->addOption( 'revhtmlfile',
						 'File containing revision HTML for selective html/wikitext updates',
						 false, true );
		$this->addOption( 'editedtemplatetitle',
						 'Title of the edited template (for --selpar)',
						 false, true );

		$this->addOption( 'inputfile', 'File containing input as an alternative to stdin', false, true );
		$this->addOption( 'logFile', 'File to log trace/dumps to', false, true );
		$this->addOption(
			'pbin',
			'Input pagebundle JSON',
			false,
			true
		);
		$this->addOption(
			'pbinfile',
			'Input pagebundle JSON file',
			false,
			true
		);
		$this->addOption(
			'pboutfile',
			'Output pagebundle JSON to file',
			false,
			true
		);
		$this->addOption(
			'pageName',
			'The page name, returned for {{PAGENAME}}. If no input is given ' .
			'(ie. empty/stdin closed), it downloads and parses the page. ' .
			'This should be the actual title of the article (that is, not ' .
			'including any URL-encoding that might be necessary in wikitext).',
			false,
			true
		);
		$this->addOption(
			'restURL',
			'Parses a RESTBase API URL (as supplied in our logs) and ' .
			'sets --domain and --pageName.  Debugging aid.',
			false,
			true
		);
		$this->addOption(
			'pageBundle',
			'Output pagebundle JSON'
		);
		$this->addOption(
			'wrapSections',
			// Override the default in Env since the wrappers are annoying in dev-mode
			'Output <section> tags (default false)'
		);
		$this->addOption(
			'linting',
			'Parse with linter enabled.'
		);
		$this->addOption(
			'logLinterData',
			'Log the linter data.  Enables --linting.  With --integrated, ' .
				'it attempts to queue up a job to add to the linter table.'
		);
		$this->addOption(
			'addHTMLTemplateParameters',
			'Parse template parameters to HTML and add them to template data'
		);
		$this->addOption(
			'domain',
			'Which wiki to use; e.g. "en.wikipedia.org" for English wikipedia, ' .
			'"es.wikipedia.org" for Spanish, "mediawiki.org" for mediawiki.org',
			false,
			true
		);
		$this->addOption(
			'apiURL',
			'http path to remote API, e.g. http://en.wikipedia.org/w/api.php',
			false,
			true
		);
		$this->addOption(
			'offsetType',
			'Represent DSR as byte/ucs2/char offsets',
			false,
			true
		);
		$this->addOption(
			'wtVariantLanguage',
			'Language variant to use for wikitext',
			false,
			true
		);
		$this->addOption(
			'htmlVariantLanguage',
			'Language variant to use for HTML',
			false,
			true
		);
		$this->addOption(
			'flamegraph',
			"Produce a flamegraph of CPU usage. " .
			"Assumes existence of Excimer ( https://www.mediawiki.org/wiki/Excimer ). " .
			"Looks for /usr/local/bin/flamegraph.pl (Set FLAMEGRAPH_PATH env var " .
			"to use different path). Outputs to /tmp (Set FLAMEGRAPH_OUTDIR " .
			"env var to output elsewhere)."
		);
		$this->addOption(
			'trace',
			'Use --trace=help for supported options',
			false,
			true
		);
		$this->addOption(
			'dump',
			'Dump state. Use --dump=help for supported options',
			false,
			true
		);
		$this->addOption(
			'debug',
			'Provide optional flags. Use --debug=help for supported options',
			false,
			true
		);
		$this->addOption(
			'revid',
			'revid of the given page.',
			false,
			true
		);
		$this->addOption(
			'normalize',
			"Normalize the output as parserTests would do. " .
			"Use --normalize for PHP tests, and --normalize=parsoid for " .
			"parsoid-only tests",
			false,
			false
		);
		$this->addOption(
			'outputContentVersion',
			'The acceptable content version.',
			false,
			true
		);
		$this->addOption(
			'verbose',
			'Log at level "info" as well'
		);
		$this->addOption(
			'maxdepth',
			'Maximum expansion depth.',
			false,
			true
		);
		$this->addOption(
			'version',
			'Show version number.'
		);
		$this->addOption(
			'contentmodel',
			"The content model of the input.  Defaults to \"wikitext\" but " .
			"extensions may support others (for example, \"json\").",
			false,
			true
		);
		$this->addOption(
			'metrics',
			'Dump a log of the metrics methods that were called from a MockMetrics.'
		);
		$this->setAllowUnregisteredOptions( false );
	}

	private function setupMwConfig( array $configOpts ): void {
		$services = MediaWikiServices::getInstance();
		$siteConfig = $services->getParsoidSiteConfig();
		// Overwriting logger so that it logs to console/file
		$logFilePath = null;
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
			? \Title::newFromText( $configOpts['title'] )
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
		$this->pageConfig = $pcFactory->create(
			$title,
			null, // UserIdentity
			$revisionRecord ?? $revision,
			null,
			null,
			$configOpts['ensureAccessibleContent']
		);
		$this->metadata = new \ParserOutput();
		$this->parsoid = new Parsoid( $siteConfig, $dataAccess );
	}

	private function setupApiConfig( array $configOpts ): void {
		$api = new ApiHelper( $configOpts );

		$siteConfig = new SiteConfig( $api, $configOpts );
		if ( $this->hasOption( 'logFile' ) ) {
			// Overwrite logger so that it logs to file
			$siteConfig->setLogger( SiteConfig::createLogger( $this->getOption( 'logFile' ) ) );
		}
		$dataAccess = new DataAccess( $api, $siteConfig, $configOpts );
		$this->siteConfig = $siteConfig;
		$configOpts['title'] = isset( $configOpts['title'] )
			? Title::newFromText( $configOpts['title'], $siteConfig )
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
	private function setupConfig( array $configOpts ) {
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
	 * @return string|PageBundle
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
		array $configOpts, array $parsoidOpts, string $html,
		?SelectiveUpdateData $selserData = null
	): string {
		$configOpts["pageContent"] = $selserData->revText ?? ''; // FIXME: T234549
		$this->setupConfig( $configOpts );

		try {
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

	private function maybeVersion() {
		if ( $this->hasOption( 'version' ) ) {
			$this->output( Parsoid::version() . "\n" );
			die( 0 );
		}
	}

	public function execute() {
		$this->maybeHelp();
		$this->maybeVersion();

		$parsoidOpts = [];
		ScriptUtils::setDebuggingFlags( $parsoidOpts, $this->getOptions() );

		if ( $this->hasOption( 'flamegraph' ) ) {
			$this->startFlameGraphProfiler();
		}

		if ( $this->hasOption( 'inputfile' ) ) {
			$input = file_get_contents( $this->getOption( 'inputfile' ) );
			if ( $input === false ) {
				return;
			}
		} else {
			if ( $this->hasOption( 'restURL' ) ) {
				$input = '';
			} else {
				$input = file_get_contents( 'php://stdin' );
			}
			if ( strlen( $input ) === 0 ) {
				// Parse page if no input
				if ( $this->hasOption( 'html2wt' ) || $this->hasOption( 'html2html' ) ) {
					$this->error(
						'Fetching page content is only supported when starting at wikitext.'
					);
					return;
				} else {
					$input = null;
				}
			}
		}

		if ( $this->hasOption( 'restURL' ) ) {
			if ( !preg_match(
				'#^(?:https?://)?([a-z.]+)/api/rest_v1/page/html/([^/?]+)#',
				$this->getOption( 'restURL' ), $matches ) &&
				 !preg_match(
				'#^(?:https?://[a-z.]+)?/w/rest\.php/([a-z.]+)/v3/transform/pagebundle/to/pagebundle/([^/?]+)#',
				$this->getOption( 'restURL' ), $matches ) &&
				 !preg_match(
				'#^(?:https?://[a-z.]+)?/w/rest.php/([a-z.]+)/v3/page/pagebundle/([^/?]+)(?:/([^/?]+))?#',
				$this->getOption( 'restURL' ), $matches ) &&
				!preg_match(
					'#^(?:https?://[a-z.]+)?/w/rest\.php/([a-z.]+)/v3/transform/wikitext/to/pagebundle/([^/?]+)#',
					$this->getOption( 'restURL' ), $matches )
			) {
				# XXX we could extend this to process other URLs, but the
				# above are the most common seen in error logs
				$this->error(
					'Bad rest url.'
				);
				return;
			}
			# Calling it with the default implicitly sets it as well.
			$this->getOption( 'domain', $matches[1] );
			$this->getOption( 'pageName', urldecode( $matches[2] ) );
			if ( isset( $matches[3] ) ) {
				$this->getOption( 'revid', $matches[3] );
			}
		}
		$apiURL = "https://en.wikipedia.org/w/api.php";
		if ( $this->hasOption( 'domain' ) ) {
			$apiURL = "https://" . $this->getOption( 'domain' ) . "/w/api.php";
		}
		if ( $this->hasOption( 'apiURL' ) ) {
			$apiURL = $this->getOption( 'apiURL' );
		}
		$configOpts = [
			"standalone" => !$this->hasOption( 'integrated' ),
			"apiEndpoint" => $apiURL,
			"addHTMLTemplateParameters" => $this->hasOption( 'addHTMLTemplateParameters' ),
			"linting" => $this->hasOption( 'linting' ) ||
				$this->hasOption( 'logLinterData' ) ||
				$this->hasOption( 'wt2lint' ),
			"mock" => $this->hasOption( 'mock' )
		];
		if ( $this->hasOption( 'pageName' ) ) {
			$configOpts['title'] = $this->getOption( 'pageName' );
		}
		if ( $this->hasOption( 'revid' ) ) {
			$configOpts['revid'] = (int)$this->getOption( 'revid' );
		}
		if ( $this->hasOption( 'maxdepth' ) ) {
			$configOpts['maxDepth'] = (int)$this->getOption( 'maxdepth' );
		}

		$parsoidOpts += [
			"body_only" => ScriptUtils::booleanOption( $this->getOption( 'body_only' ) ),
			"wrapSections" => $this->hasOption( 'wrapSections' ),
			"logLinterData" => $this->hasOption( 'logLinterData' ),
			"pageBundle" =>
			$this->hasOption( 'pageBundle' ) || $this->hasOption( 'pboutfile' ),
		];
		foreach ( [
			'offsetType', 'outputContentVersion',
			'wtVariantLanguage', 'htmlVariantLanguage',
			'contentmodel'
		] as $opt ) {
			if ( $this->hasOption( $opt ) ) {
				$parsoidOpts[$opt] = $this->getOption( $opt );
			}
		}
		if ( !$this->hasOption( 'verbose' ) ) {
			$parsoidOpts['logLevels'] = [ 'fatal', 'error', 'warn' ];
		}

		if ( $this->hasOption( 'profile' ) ) {
			$parsoidOpts['traceFlags'] ??= [];
			$parsoidOpts['traceFlags']['time'] = true;
		}

		$startsAtHtml = $this->hasOption( 'html2wt' ) ||
			$this->hasOption( 'html2html' ) ||
			$this->hasOption( 'selser' );

		$configOpts['ensureAccessibleContent'] = !$startsAtHtml ||
			isset( $configOpts['revid'] );

		if ( $startsAtHtml ) {
			$this->transformFromHtml( $configOpts, $parsoidOpts, $input );
		} else {
			$this->transformFromWt( $configOpts, $parsoidOpts, $input );
		}

		if ( $this->hasOption( 'metrics' ) ) {
			// FIXME: We're just using whatever siteConfig we ended up with,
			// even though setupConfig may be called multiple times
			$metrics = $this->siteConfig->metrics();
			if ( $metrics instanceof MockMetrics ) {
				$this->error( print_r( $metrics->log, true ) );
			}
		}
	}

	/**
	 * Produce a CPU flamegraph via excimer's profiling
	 */
	private function startFlameGraphProfiler() {
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
			$startTime = microtime( true );
			for ( $i = 0; $i < $count; $i++ ) {
				$callback();
			}
			$total = ( microtime( true ) - $startTime ) * 1000;
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
	private function transformFromHtml( $configOpts, $parsoidOpts, $input ) {
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
		$doc = DOMUtils::parseHTML( $input );
		if ( $this->hasOption( 'pbinfile' ) ) {
			$json = file_get_contents( $this->getOption( 'pbinfile' ) );
		} else {
			$json = $this->getOption( 'pbin' );
		}
		$pb = PHPUtils::jsonDecode( $json );
		$pb = new PageBundle(
			'',
			$pb['parsoid'] ?? null,
			[ 'ids' => [] ]  // FIXME: ^999.0.0
		);
		PageBundle::apply( $doc, $pb );
		return ContentUtils::toXML( $doc );
	}

	/**
	 * Do a wt2html or wt2wt operation and output the result
	 *
	 * @param array $configOpts
	 * @param array $parsoidOpts
	 * @param string $input
	 */
	private function transformFromWt( $configOpts, $parsoidOpts, $input ) {
		if ( $this->hasOption( 'selpar' ) ) {
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
				$html = $this->wt2Html( $configOpts, $parsoidOpts, $input );
				file_put_contents(
					$this->getOption( 'pboutfile' ),
					PHPUtils::jsonEncode( [
						'parsoid' => $html->parsoid,
						'mw' => $html->mw,
					] )
				);
				$html = $html->html;
			} elseif ( $this->hasOption( 'pageBundle' ) ) {
				$html = $this->wt2Html( $configOpts, $parsoidOpts, $input );
				// Stitch this back in, even though it was just extracted
				$doc = DOMUtils::parseHTML( $html->html );
				DOMDataUtils::injectPageBundle(
					$doc,
					new PageBundle( '', $html->parsoid, $html->mw )
				);
				$html = ContentUtils::toXML( $doc );
			}
			$this->output( $this->maybeNormalize( $html ) );
		} else {
			$this->benchmark( function () use ( $configOpts, $parsoidOpts, $input ) {
				return $this->wt2Html( $configOpts, $parsoidOpts, $input );
			} );
		}
	}
}

$maintClass = Parse::class;
require_once PARSOID_RUN_MAINTENANCE_IF_MAIN;
