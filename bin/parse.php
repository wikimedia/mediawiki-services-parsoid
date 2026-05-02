<?php
declare( strict_types = 1 );

/**
 * At present, this script is just used for testing the library and uses a
 * public MediaWiki API, which means it's expected to be slow.
 */

require_once __DIR__ . '/../tools/Maintenance.php';

use Wikimedia\Bcp47Code\Bcp47CodeValue;
use Wikimedia\Parsoid\Mocks\MockMetrics;
use Wikimedia\Parsoid\Parsoid;
use Wikimedia\Parsoid\Tools\ExtendedOptsProcessor;
use Wikimedia\Parsoid\Tools\ParseUtils;
use Wikimedia\Parsoid\Utils\ScriptUtils;

// phpcs:ignore MediaWiki.Files.ClassMatchesFilename.WrongCase
class Parse extends ParseUtils {
	use ExtendedOptsProcessor;

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
		$this->addOption( 'debug-oom',
			'Show peak memory usage at different points in code execution. ' .
			'This enables --profile as well.'
		);
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
			'title',
			'The title of the page the input belongs to, returned for ' .
			'{{PAGENAME}}. ' .
			'This should be the actual title of the article (that is, not ' .
			'including any URL-encoding that might be necessary in wikitext).',
			false,
			true
		);
		$this->addOption(
			'page',
			'Instead of parsing stdin, fetch and parse the content of this ' .
			'page.  Cannot be used together with title. ' .
			'This should be the actual title of the article (that is, not ' .
			'including any URL-encoding that might be necessary in wikitext).',
			false,
			true
		);
		$this->addOption(
			'pageName',
			'Backward-compatibility alias for --page if no input is given, ' .
			'or --title if input is provided on stdin.',
			false,
			true
		);
		$this->addOption(
			'restURL',
			'Parses a RESTBase API URL (as supplied in our logs) and ' .
			'sets --domain and --page.  Debugging aid.',
			false,
			true
		);
		$this->addOption(
			'pageBundle',
			'Output pagebundle JSON'
		);
		$this->addOption(
			'fragmentbank',
			'Use fragment bank representation for embedded HTML'
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
			'nativeTemplateExpansion',
			'Use native template expansion mode'
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
		$this->addOption( 'v3pf', 'Generate Parsoid v3 parser function output for all parser functions' );
		$this->addOption(
			'record',
			'Record HTTP requests for later replay'
		);
		$this->addOption(
			'replay',
			'Replay recorded HTTP requests for offline testing or benchmarking.'
		);
		$this->addOption(
			'record-dir',
			'Specify a desired storage directory for --record/--replay; ' .
			'defaults to .record',
			false,
			true
		);
		$this->addOption(
			'apiToken',
			# See https://api.wikimedia.org/wiki/Authentication#Personal_API_tokens
			'Specify a personal API token; use @<filename> to load from a file',
			false,
			true
		);
		$this->setAllowUnregisteredOptions( false );
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
			if ( $this->hasOption( 'restURL' ) || $this->hasOption( 'page' ) ) {
				$input = null; // fetch
			} else {
				$input = file_get_contents( 'php://stdin' );
				if ( $this->hasOption( 'pageName' ) ) {
					$pageName = $this->getOption( 'pageName' );
					if ( strlen( $input ) === 0 ) {
						// implicitly sets the option by supplying a default
						$this->getOption( 'page', $pageName );
						$input = null; // fetch
					} else {
						// implicitly sets the option by supplying a default
						$this->getOption( 'title', $pageName );
					}
				}
			}
			if ( $input === null ) {
				// Parse page if no input
				if ( $this->hasOption( 'html2wt' ) || $this->hasOption( 'html2html' ) ) {
					$this->error(
						'Fetching page content is only supported when starting at wikitext.'
					);
					return;
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
			$this->getOption( 'page', urldecode( $matches[2] ) );
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
		if ( $this->hasOption( 'title' ) ) {
			$configOpts['title'] = $this->getOption( 'title' );
		}
		if ( $this->hasOption( 'page' ) ) {
			$configOpts['title'] = $this->getOption( 'page' );
		}
		if ( $this->hasOption( 'revid' ) ) {
			$configOpts['revid'] = (int)$this->getOption( 'revid' );
		}
		if ( $this->hasOption( 'maxdepth' ) ) {
			$configOpts['maxDepth'] = (int)$this->getOption( 'maxdepth' );
		}
		if ( $this->hasOption( 'v3pf' ) ) {
			$configOpts['v3pf'] = true;
		}
		if ( $this->hasOption( 'record' ) || $this->hasOption( 'replay' ) ) {
			$cacheDir = __DIR__ . '/../.record';
			$cacheDir = $this->getOption( 'record-dir', $cacheDir );
			if ( !is_dir( $cacheDir ) ) {
				mkdir( $cacheDir, 0777, true );
			}
			$configOpts['cacheDir'] = $cacheDir;
			if ( $this->hasOption( 'record' ) ) {
				$configOpts['writeToCache'] = true; # or 'pretty'
			} elseif ( $this->hasOption( 'replay' ) ) {
				// Specifying --record --replay together will silently fetch
				// any missing API requests; otherwise with just --replay
				// we'll throw an error if we're missing anything.
				$configOpts['onlyCached'] = true;
			}
		}
		if ( $this->hasOption( 'apiToken' ) ) {
			$apiToken = $this->getOption( 'apiToken' );
			// These tokens can be long, support loading from a file as well
			if ( str_starts_with( $apiToken, '@' ) ) {
				$apiToken = file_get_contents( substr( $apiToken, 1 ) );
			}
			$configOpts['apiToken'] = trim( $apiToken );
		}

		$parsoidOpts += [
			"body_only" => ScriptUtils::booleanOption( $this->getOption( 'body_only' ) ),
			"wrapSections" => $this->hasOption( 'wrapSections' ),
			"logLinterData" => $this->hasOption( 'logLinterData' ),
			"pageBundle" =>
				$this->hasOption( 'pageBundle' ) || $this->hasOption( 'pboutfile' ),
			"nativeTemplateExpansion" => $this->hasOption( 'nativeTemplateExpansion' ),
		];
		if ( $this->hasOption( 'fragmentbank' ) ) {
			$parsoidOpts['useFragmentBank'] = true;
			$parsoidOpts['body_only'] = false;
		}

		foreach ( [ 'htmlVariantLanguage', 'wtVariantLanguage' ] as $opt ) {
			if ( $this->hasOption( $opt ) ) {
				$parsoidOpts[$opt] = new Bcp47CodeValue( $this->getOption( $opt ) );
			}
		}

		foreach ( [
			'offsetType', 'outputContentVersion', 'contentmodel'
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
		if ( $this->hasOption( 'debug-oom' ) ) {
			// Enable --profile
			$parsoidOpts['traceFlags'] ??= [];
			$parsoidOpts['traceFlags']['time'] = true;
			$parsoidOpts['debugFlags']['oom'] = true;
			$parsoidOpts['dumpFlags']['oom'] = true; // HACK
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
}

$maintClass = Parse::class;
require_once PARSOID_RUN_MAINTENANCE_IF_MAIN;
