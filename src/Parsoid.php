<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid;

use Composer\InstalledVersions;
use Composer\Semver\Comparator;
use Composer\Semver\Semver;
use InvalidArgumentException;
use LogicException;
use Wikimedia\Assert\Assert;
use Wikimedia\Bcp47Code\Bcp47Code;
use Wikimedia\Parsoid\Config\DataAccess;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Config\PageConfig;
use Wikimedia\Parsoid\Config\SiteConfig;
use Wikimedia\Parsoid\Config\StubMetadataCollector;
use Wikimedia\Parsoid\Core\ContentMetadataCollector;
use Wikimedia\Parsoid\Core\DomPageBundle;
use Wikimedia\Parsoid\Core\HtmlPageBundle;
use Wikimedia\Parsoid\Core\ResourceLimitExceededException;
use Wikimedia\Parsoid\Core\SelectiveUpdateData;
use Wikimedia\Parsoid\DOM\Document;
use Wikimedia\Parsoid\Ext\ParsoidExtensionAPI;
use Wikimedia\Parsoid\Language\LanguageConverter;
use Wikimedia\Parsoid\Logger\LintLogger;
use Wikimedia\Parsoid\Mocks\MockSiteConfig;
use Wikimedia\Parsoid\Utils\ComputeSelectiveStats;
use Wikimedia\Parsoid\Utils\ContentUtils;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\DOMUtils;
use Wikimedia\Parsoid\Utils\Histogram;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Utils\Timing;
use Wikimedia\Parsoid\Utils\Utils;
use Wikimedia\Parsoid\Wt2Html\DOM\Processors\AddRedLinks;
use Wikimedia\Parsoid\Wt2Html\DOM\Processors\ConvertOffsets;

class Parsoid {

	/**
	 * Available HTML content versions.
	 * @see https://www.mediawiki.org/wiki/Parsoid/API#Content_Negotiation
	 * @see https://www.mediawiki.org/wiki/Specs/HTML#Versioning
	 */
	public const AVAILABLE_VERSIONS = [ '2.8.0', '999.0.0' ];

	private const DOWNGRADES = [
		[ 'from' => '999.0.0', 'to' => '2.0.0', 'func' => 'downgrade999to2' ],
	];

	/** @var SiteConfig */
	private $siteConfig;

	/** @var DataAccess */
	private $dataAccess;
	private Histogram $histogram;

	public function __construct(
		SiteConfig $siteConfig, DataAccess $dataAccess
	) {
		$this->siteConfig = $siteConfig;
		$this->dataAccess = $dataAccess;
		$this->histogram = new Histogram( $this->siteConfig );
	}

	/**
	 * Returns the currently-installed version of Parsoid.
	 * @return string
	 */
	public static function version(): string {
		try {
			// See https://getcomposer.org/doc/07-runtime.md#knowing-the-version-of-package-x
			return InstalledVersions::getVersion( 'wikimedia/parsoid' ) ??
				// From the composer runtime API docs:
				// "It is nonetheless a good idea to make sure you
				// handle the null return value as gracefully as
				// possible for safety."
				'null';
		} catch ( \Throwable ) {
			// Belt-and-suspenders protection against parts of the composer
			// runtime API being absent in production.
			return 'error';
		}
	}

	/**
	 * Returns the default HTML content version
	 * @return string
	 */
	public static function defaultHTMLVersion(): string {
		return self::AVAILABLE_VERSIONS[0];
	}

	/**
	 * See if any content version Parsoid knows how to produce satisfies the
	 * the supplied version, when interpreted with semver caret semantics.
	 * This will allow us to make backwards compatible changes, without the need
	 * for clients to bump the version in their headers all the time.
	 */
	public static function resolveContentVersion( string $version ): ?string {
		foreach ( self::AVAILABLE_VERSIONS as $a ) {
			if ( Semver::satisfies( $a, "^{$version}" ) &&
				// The section wrapping in 1.6.x should have induced a major
				// version bump, since it requires upgrading clients to
				// handle it.  We therefore hardcode this in so that we can
				// fail hard.
				Comparator::greaterThanOrEqualTo( $version, '1.6.0' )
			) {
				return $a;
			}
		}
		return null;
	}

	/**
	 * Determine if language conversion is enabled, aka if the optional
	 * wikimedia/langconv library is installed.
	 * @return bool True if the wikimedia/langconv library is available
	 */
	public static function supportsLanguageConversion(): bool {
		return class_exists( '\Wikimedia\LangConv\ReplacementMachine' );
	}

	private function setupCommonOptions( array $options ): array {
		$envOptions = [];
		if ( isset( $options['offsetType'] ) ) {
			$envOptions['offsetType'] = $options['offsetType'];
		}
		if ( isset( $options['traceFlags'] ) ) {
			$envOptions['traceFlags'] = $options['traceFlags'];
		}
		if ( isset( $options['dumpFlags'] ) ) {
			$envOptions['dumpFlags'] = $options['dumpFlags'];
		}
		if ( isset( $options['debugFlags'] ) ) {
			$envOptions['debugFlags'] = $options['debugFlags'];
		}
		if ( !empty( $options['htmlVariantLanguage'] ) ) {
			$envOptions['htmlVariantLanguage'] = $options['htmlVariantLanguage'];
		}
		if ( !empty( $options['wtVariantLanguage'] ) ) {
			$envOptions['wtVariantLanguage'] = $options['wtVariantLanguage'];
		}
		if ( isset( $options['logLevels'] ) ) {
			$envOptions['logLevels'] = $options['logLevels'];
		}
		return $envOptions;
	}

	/**
	 * Parsing code shared between the next two methods.
	 *
	 * @param PageConfig $pageConfig
	 * @param ContentMetadataCollector $metadata
	 * @param array $options See wikitext2html.
	 * @param ?SelectiveUpdateData $selparData See wikitext2html.
	 * @return list{Env,Document,?string}
	 *  The returned document is in "prepared and loaded" form.
	 */
	private function parseWikitext(
		PageConfig $pageConfig,
		ContentMetadataCollector $metadata,
		array $options = [],
		?SelectiveUpdateData $selparData = null
	): array {
		$envOptions = $this->setupCommonOptions( $options );
		if ( isset( $options['outputContentVersion'] ) ) {
			$envOptions['outputContentVersion'] = $options['outputContentVersion'];
		}
		if ( isset( $options['wrapSections'] ) ) {
			$envOptions['wrapSections'] = (bool)$options['wrapSections'];
		}
		if ( isset( $options['pageBundle'] ) ) {
			$envOptions['pageBundle'] = (bool)$options['pageBundle'];
		}
		if ( isset( $options['logLinterData'] ) ) {
			$envOptions['logLinterData'] = (bool)$options['logLinterData'];
		}
		if ( isset( $options['linterOverrides'] ) ) {
			$envOptions['linterOverrides'] = $options['linterOverrides'];
		}
		$envOptions['skipLanguageConversionPass'] =
			$options['skipLanguageConversionPass'] ?? false;
		$envOptions['nativeTemplateExpansion'] =
			$options['nativeTemplateExpansion'] ?? false;
		$env = new Env(
			$this->siteConfig, $pageConfig, $this->dataAccess, $metadata, $envOptions
		);
		// XXX: T405759 Frame::getSource() is deprecated; this resource bump
		// should probably be done elsewhere, like at the start of the parser
		// pipeline where we have a $wikitext string.
		if ( !$env->compareWt2HtmlLimit(
			'wikitextSize', strlen( $env->topFrame->getSource()->getSrcText() )
		) ) {
			throw new ResourceLimitExceededException(
				"wt2html: wikitextSize limit exceeded"
			);
		}
		$contentmodel = $options['contentmodel'] ?? null;
		$handler = $env->getContentHandler( $contentmodel );
		$extApi = new ParsoidExtensionAPI( $env );
		$doc = $handler->toDOM( $extApi, $selparData );
		if ( !DOMDataUtils::isPreparedAndLoaded( $doc ) ) {
			// DEPRECATED. Extensions for other content types might still
			// be returning plain/stored docs here.  Prepare and load them
			// for consistency.
			$dpb = new DomPageBundle( $doc );
			$doc = $dpb->toDom();
		}
		return [ $env, $doc, $contentmodel ];
	}

	/**
	 * Parse the wikitext supplied in a `PageConfig` to HTML.
	 *
	 * @param PageConfig $pageConfig
	 * @param array $options [
	 *   'wrapSections'         => (bool) Whether `<section>` wrappers should be added.
	 *   'pageBundle'           => (bool) Sets ids on nodes and stores
	 *                                    data-* attributes in a JSON blob.
	 *   'body_only'            => (bool|null) Only return the <body> children (T181657)
	 *   'outputContentVersion' => (string|null) Version of HTML to output.
	 *                                           `null` returns the default version.
	 *   'contentmodel'         => (string|null) The content model of the input.
	 *   'offsetType'           => (string) ucs2, char, byte are valid values
	 *                                      what kind of source offsets should be emitted?
	 *   'skipLanguageConversionPass'  => (bool) Skip the language variant conversion pass (defaults to false)
	 *   'htmlVariantLanguage'  => (Bcp47Code) If non-null, the language variant used for Parsoid HTML.
	 *   'wtVariantLanguage'    => (Bcp47Code) If non-null, the language variant used for wikitext.
	 *   'logLinterData'        => (bool) Should we log linter data if linting is enabled?
	 *   'linterOverrides'      => (array) Override the site linting configs.
	 *   // Debugging options, not for use in production
	 *   'traceFlags'           => (array) associative array with tracing options
	 *   'dumpFlags'            => (array) associative array with dump options
	 *   'debugFlags'           => (array) associative array with debug options
	 *   'logLevels'            => (string[]) Levels to log
	 *   // Experimental options, not considered stable
	 *   'useFragmentBank'      => (bool) Alternative encoding of embedded HTML
	 *   'sampleStats'          => (bool) If true, okay to perform "expensive"
	 *                             analysis to generate metrics.
	 *   'renderReason'         => (?string) Passed through from MediaWiki core
	 *                             to classify metrics; see
	 *                             ParserOptions::getRenderReason()
	 *   'previousInput'        => (?PageConfig) wikitext, revision ID, etc of
	 *                             some recent parse of this page.
	 *                             Not guaranteed to be usable for selective
	 *                             update, and could even be from a "newer"
	 *                             revision (if this is a render of an old
	 *                             revision).
	 *   'previousOutput'       => (?HtmlPageBundle) output of the prior parse of
	 *                             'previousInput'
	 * ]
	 * @param ?array &$headers
	 * @param ?ContentMetadataCollector $metadata Pass in a CMC in order to
	 *  collect and retrieve metadata about the parse.
	 * @param ?SelectiveUpdateData $selparData
	 * @return HtmlPageBundle|string
	 */
	public function wikitext2html(
		PageConfig $pageConfig, array $options = [], ?array &$headers = null,
		?ContentMetadataCollector $metadata = null, ?SelectiveUpdateData $selparData = null
	) {
		if ( $metadata === null ) {
			$metadata = new StubMetadataCollector( $this->siteConfig );
		}

		$parseTiming = Timing::start();
		[ $env, $doc, $contentmodel ] = $this->parseWikitext( $pageConfig, $metadata, $options, $selparData );
		DOMDataUtils::visitAndStoreDataAttribs( DOMCompat::getBody( $doc ), [
			'storeInPageBundle' => $env->pageBundle,
			'outputContentVersion' => $env->getOutputContentVersion(),
			'useFragmentBank' => $options['useFragmentBank'] ?? false,
			'idIndex' => $env->pageBundle ?
				DOMDataUtils::usedIdIndex( $env->getSiteConfig(), $doc ) : null,
		] );
		$parseTimeMs = $parseTiming->end();

		// FIXME: Does this belong in parseWikitext so that the other endpoint
		// is covered as well?  It probably depends on expectations of the
		// Rest API.  If callers of /page/lint/ assume that will update the
		// results on the Special page.
		if ( $env->linting() ) {
			( new LintLogger( $env ) )->logLintOutput();
		}

		$headers = DOMUtils::findHttpEquivHeaders( $doc );
		$body_only = !empty( $options['body_only'] );
		$node = $body_only ? DOMCompat::getBody( $doc ) : $doc;

		if ( $env->pageBundle ) {
			$out = [
				'pb' => HtmlPageBundle::fromDomPageBundle( $env->pageBundle, [
					'body_only' => $body_only,
					'contentversion' => $env->getOutputContentVersion(),
					'headers' => $headers,
					'contentmodel' => $contentmodel,
					'offsetType' => $env->getCurrentOffsetType(),
				] ),
			];
			$out['html'] = $out['pb']->html; // for use in metrics
		} else {
			$out = [
				'html' => ContentUtils::toXML( $node, [
					'innerXML' => $body_only,
				] ),
			];
		}

		$this->recordParseMetrics(
			$env, $parseTimeMs, $out, $headers, $contentmodel, $options
		);

		if ( $env->pageBundle ) {
			return $out['pb'];
		} else {
			return $out['html'];
		}
	}

	private function recordParseMetrics(
		Env $env, float $parseTimeMs,
		array $out, ?array $headers, string $contentmodel,
		array $options
	): void {
		$metrics = $this->siteConfig->metrics();

		$pageConfig = $env->getPageConfig();

		// This is somewhat suspect because ParsoidHandler::tryToCreatePageConfig
		// can set a revision id on a MutableRevisionRecord, but it might be simpler
		// to make that go away
		if ( $pageConfig->getRevisionId() ) {
			$mstr = 'pageWithOldid';
		} else {
			$mstr = 'wt';
		}

		$timing = Timing::fakeTiming( $this->siteConfig, $parseTimeMs );
		$timing->end( "entry.wt2html.{$mstr}.parse", 'wt2html_parse_seconds', [ 'type' => $mstr ] );
		$version = 'default';

		if ( Semver::satisfies(
			$env->getOutputContentVersion(), '!=' . self::defaultHTMLVersion()
		) ) {
			if ( $metrics ) {
				$metrics->increment( 'entry.wt2html.parse.version.notdefault' );
			}
			$version = 'non-default';
		}

		$this->siteConfig->incrementCounter( 'wt2html_parse_total', [
			'type' => $mstr,
			'version' => $version
		] );

		// TODO: Remove fake timing after migration to histogram is complete
		// @phan-suppress-next-line PhanDeprecatedFunction
		$inSize = $pageConfig->getPageMainContent();
		$timing = Timing::fakeTiming( $this->siteConfig, strlen( $inSize ), false );
		$timing->end(
			"entry.wt2html.{$mstr}.size.input",
			"legacy_wt2html_size_input_bytes",
			[ "type" => $mstr ]
		);
		$this->histogram->observe(
			"wt2html_size_input_bytes",
			strlen( $inSize ),
			[ "type" => $mstr ]
		);

		$outSize = strlen( $out['html'] );
		// TODO: Remove fake timing after migration to histogram is complete
		$timing = Timing::fakeTiming( $this->siteConfig, $outSize, false );
		$timing->end( "entry.wt2html.{$mstr}.size.output", "legacy_wt2html_size_output_bytes", [ "type" => $mstr ] );
		$this->histogram->observe( "wt2html_size_output_bytes", $outSize, [ "type" => $mstr ] );

		if ( $parseTimeMs > 10 && $outSize > 100 ) {
			// * Don't bother with this metric for really small parse times
			//   p99 for initialization time is ~7ms according to grafana.
			//   So, 10ms ensures that startup overheads don't skew the metrics
			// * For body_only=false requests, <head> section isn't generated
			//   and if the output is small, per-request overheads can skew
			//   the timePerKB metrics.
			//
			// NOTE: This is slightly misleading since there are fixed costs
			// for generating output like the <head> section and should be factored in,
			// but this is good enough for now as a useful first degree of approxmation.

			// TODO: Remove fake timing after migration to histogram is complete
			$msPerKB = $parseTimeMs * 1024 / $outSize;
			$timing = Timing::fakeTiming( $this->siteConfig, $msPerKB );
			$timing->end(
				'entry.wt2html.timePerKB',
				'legacy_wt2html_msPerKB',
				[]
			);
			$this->histogram->observe( 'wt2html_msPerKB', $msPerKB );
		}

		// Expensive analyses: sampleStats is randomly sampled will not be
		// true "often"
		$doSample = $options['sampleStats'] ?? false;
		if ( !$doSample ) {
			return;
		}

		try {
			// create new page bundle for this computation to ensure we
			// don't inadvertently corrupt the main document result.
			$newPb = new HtmlPageBundle(
				$out['html'],
				$out['pb']->parsoid ?? null, $out['pb']->mw ?? null,
				$env->getOutputContentVersion(),
				$headers,
				$contentmodel
			);
			$labels = ComputeSelectiveStats::classify(
				$env,
				$options['previousInput'] ?? null,
				$options['previousOutput'] ?? null,
				$pageConfig,
				$newPb
			);
			$labels['wiki'] = $this->siteConfig->iwp();
			$labels['reason'] = $options['renderReason'] ?? 'unknown';
			$labels['useragent'] = ComputeSelectiveStats::filterUserAgent( $options['userAgent'] ?: null );

			$this->siteConfig->incrementCounter( 'selective_update_total', $labels );
			$this->siteConfig->incrementCounter( 'selective_update_seconds', $labels, $parseTimeMs / 1000. );
		} catch ( \Throwable $t ) {
			// Don't ever allow bugs in the classification code to
			// impact the availability of content for read views/editing,
			// just log.
			$env->log( 'warn', 'Classification failure', $t->getTraceAsString() );
		}
	}

	/**
	 * Lint the wikitext supplied in a `PageConfig`.
	 *
	 * @param PageConfig $pageConfig
	 * @param array $options See wikitext2html.
	 * @param ?ContentMetadataCollector $metadata Pass in a CMC in order to
	 *  collect and retrieve metadata about the parse.
	 * @return array
	 */
	public function wikitext2lint(
		PageConfig $pageConfig, array $options = [],
		?ContentMetadataCollector $metadata = null
	): array {
		if ( $metadata === null ) {
			$metadata = new StubMetadataCollector( $this->siteConfig );
		}
		[ $env, ] = $this->parseWikitext( $pageConfig, $metadata, $options );
		return $env->getLints();
	}

	/**
	 * Serialize DOM to wikitext.
	 *
	 * @param PageConfig $pageConfig
	 * @param Document|HtmlPageBundle|DomPageBundle $doc This is either a page
	 *   bundle or a "naive" DOM without special handling of
	 *   data-parsoid/data-mw etc.  A naive DOM can either be in "single
	 *   document" form (data attributes in an element in the <head>) or in
	 *   "inline attributes" form.
	 * @param array $options [
	 *   'inputContentVersion' => (string) The content version of the input.
	 *     Necessary if it differs from the current default in order to
	 *     account for any serialization differences.
	 *   'offsetType'          => (string) ucs2, char, byte are valid values
	 *                                     what kind of source offsets are present in the HTML?
	 *   'contentmodel'        => (string|null) The content model of the input.
	 *   'htmlVariantLanguage' => (Bcp47Code) If non-null, the language variant used for Parsoid HTML.
	 *   'wtVariantLanguage'   => (Bcp47Code) If non-null, the language variant used for wikitext.
	 *   'traceFlags'          => (array) associative array with tracing options
	 *   'dumpFlags'           => (array) associative array with dump options
	 *   'debugFlags'          => (array) associative array with debug options
	 *   'logLevels'           => (string[]) Levels to log
	 *   'htmlSize'            => (int) Size of the HTML that generated $doc
	 * ]
	 * @param ?SelectiveUpdateData $selserData
	 * @return string
	 */
	public function dom2wikitext(
		PageConfig $pageConfig, $doc, array $options = [],
		?SelectiveUpdateData $selserData = null
	): string {
		if ( $doc instanceof Document ) {
			Assert::invariant(
				!DOMDataUtils::isPrepared( $doc ),
				"document should not be already prepared"
			);
		}
		$envOptions = $this->setupCommonOptions( $options );
		if ( isset( $options['inputContentVersion'] ) ) {
			$envOptions['inputContentVersion'] = $options['inputContentVersion'];
		}
		$envOptions['topLevelDoc'] = self::prepareAndLoadDocOrBundle( $doc );
		$metadata = new StubMetadataCollector( $this->siteConfig );
		$env = new Env(
			$this->siteConfig, $pageConfig, $this->dataAccess, $metadata, $envOptions
		);
		$env->bumpHtml2WtResourceUse( 'htmlSize', $options['htmlSize'] ?? 0 );
		$contentmodel = $options['contentmodel'] ?? null;
		$handler = $env->getContentHandler( $contentmodel );
		$extApi = new ParsoidExtensionAPI( $env );

		$serialTiming = Timing::start();
		$wikitext = $handler->fromDOM( $extApi, $selserData );
		$serialTime = $serialTiming->end();

		$this->recordSerializationMetrics( $options, $serialTime, $wikitext );

		return $wikitext;
	}

	private function recordSerializationMetrics(
		array $options, float $serialTime, string $wikitext
	): void {
		$siteConfig = $this->siteConfig;
		$metrics = $siteConfig->metrics();

		$htmlSize = $options['htmlSize'] ?? 0;
		$timing = Timing::fakeTiming( $this->siteConfig, $htmlSize, false );
		// TODO: Remove fake timing after migration to histogram is complete
		$timing->end( 'entry.html2wt.size.input', 'legacy_html2wt_size_input_bytes' );
		$this->histogram->observe( 'html2wt_size_input_bytes', $htmlSize );

		if ( isset( $options['inputContentVersion'] ) ) {
			if ( $metrics ) {
				$metrics->increment(
					'entry.html2wt.original.version.' . $options['inputContentVersion']
				);
			}
			$this->siteConfig->incrementCounter(
				'html2wt_original_version',
				[ 'input_content_version' => $options['inputContentVersion'] ]
			);
		}

		$timing = Timing::fakeTiming( $this->siteConfig, $serialTime );
		$timing->end( 'entry.html2wt.total', 'html2wt_total_seconds', [] );

		$timing = Timing::fakeTiming( $this->siteConfig, strlen( $wikitext ), false );
		// TODO: Remove fake timing after migration to histogram is complete
		$timing->end( 'entry.html2wt.size.output', 'legacy_html2wt_size_output_bytes', [] );
		$this->histogram->observe( 'html2wt_size_output_bytes', strlen( $wikitext ) );

		if ( $htmlSize ) {  // Avoid division by zero
			// NOTE: the name timePerInputKB is misleading, since $htmlSize is
			//       in characters, not bytes.
			$msPerKB = $serialTime * 1024 / $htmlSize;
			// TODO: Remove fake timing after migration to histogram is complete
			$timing = Timing::fakeTiming( $this->siteConfig, $msPerKB );
			$timing->end(
				'entry.html2wt.timePerInputKB',
				'legacy_html2wt_msPerKB',
				[]
			);
			$this->histogram->observe( 'html2wt_msPerKB', $msPerKB );
		}
	}

	/**
	 * Serialize HTML to wikitext.  Convenience method for dom2wikitext.
	 *
	 * @param PageConfig $pageConfig
	 * @param string $html
	 * @param array $options
	 * @param ?SelectiveUpdateData $selserData
	 * @return string
	 */
	public function html2wikitext(
		PageConfig $pageConfig, string $html, array $options = [],
		?SelectiveUpdateData $selserData = null
	): string {
		$doc = DOMUtils::parseHTML( $html, true );
		$options['htmlSize'] ??= mb_strlen( $html );
		return $this->dom2wikitext( $pageConfig, $doc, $options, $selserData );
	}

	/**
	 * Update the supplied HtmlPageBundle based on the `$update` type.
	 *
	 *   'convertoffsets': Convert offsets between formats (byte, char, ucs2)
	 *   'redlinks': Refreshes the classes of known, missing, etc. links.
	 *   'variant': Converts the HTML based on the supplied variant.
	 *
	 * Note that these are DOM transforms, and not roundtrips through wikitext.
	 *
	 * @param PageConfig $pageConfig
	 * @param string $update 'redlinks'|'variant'
	 * @param HtmlPageBundle|DomPageBundle $pb
	 * @param array $options
	 * @return HtmlPageBundle
	 */
	public function pb2pb(
		PageConfig $pageConfig, string $update, $pb,
		array $options = []
	): HtmlPageBundle {
		$envOptions = [
			'pageBundle' => true,
			'topLevelDoc' => self::prepareAndLoadDocOrBundle( $pb ),
		];
		$metadata = new StubMetadataCollector( $this->siteConfig );
		$env = new Env(
			$this->siteConfig, $pageConfig, $this->dataAccess, $metadata, $envOptions
		);
		$doc = $env->getTopLevelDoc();

		switch ( $update ) {
			case 'convertoffsets':
				// This method also calls Env::setCurrentOffsetType, which
				// is used by HtmlPageBundle::fromDomPageBundle() below to set
				// 'offsetType' in the 'parsoid' property of the page bundle
				ContentUtils::convertOffsets(
					$env, $doc, $options['inputOffsetType'], $options['outputOffsetType']
				);
				if ( isset( $pb->parsoid['counter'] ) ) {
					$env->pageBundle->parsoid['counter'] = $pb->parsoid['counter'];
				}
				break;

			case 'redlinks':
				ContentUtils::convertOffsets(
					$env, $doc, $env->getRequestOffsetType(), 'byte'
				);
				( new AddRedLinks() )->run( $env, DOMCompat::getBody( $doc ) );
				( new ConvertOffsets() )->run( $env, DOMCompat::getBody( $doc ), [], true );
				break;

			case 'variant':
				ContentUtils::convertOffsets(
					$env, $doc, $env->getRequestOffsetType(), 'byte'
				);

				// Note that `maybeConvert` could still be a no-op, in case the
				// __NOCONTENTCONVERT__ magic word is present, or the htmlVariant
				// is a base language code or otherwise invalid.
				$hasWtVariant = $options['variant']['wikitext'] ??
					// Deprecated name for this option:
					$options['variant']['source'] ?? false;
				LanguageConverter::maybeConvert(
					$env, $doc,
					Utils::mwCodeToBcp47(
						$options['variant']['html'] ??
						// Deprecated name for this option:
						$options['variant']['target'],
						// Be strict in what we accept.
						true, $this->siteConfig->getLogger()
					),
					$hasWtVariant ?
					Utils::mwCodeToBcp47(
						$options['variant']['wikitext'] ??
						// Deprecated name for this option:
						$options['variant']['source'],
						// Be strict in what we accept.
						true, $this->siteConfig->getLogger()
					) : null
				);

				// NOTE: Keep this in sync with code in core's LanguageVariantConverter
				// Update content-language and vary headers.
				DOMUtils::addHttpEquivHeaders( $doc, [
					'content-language' => $env->htmlContentLanguageBcp47()->toBcp47Code(),
					'vary' => $env->htmlVary()
				] );

				( new ConvertOffsets() )->run( $env, DOMCompat::getBody( $doc ), [], true );
				break;

			default:
				throw new LogicException( $update . 'is an unknown transformation' );
		}

		DOMDataUtils::visitAndStoreDataAttribs(
			DOMCompat::getBody( $doc ), [
				'storeInPageBundle' => $env->pageBundle,
				'outputContentVersion' => $env->getOutputContentVersion(),
				'idIndex' => $env->pageBundle ?
					DOMDataUtils::usedIdIndex( $env->getSiteConfig(), $doc ) : null,
			]
		);
		return HtmlPageBundle::fromDomPageBundle( $env->pageBundle, [
			'body_only' => !empty( $options['body_only'] ),
			// Prefer the passed in version, since this was just a transformation
			'contentversion' => $pb->version ?? $env->getOutputContentVersion(),
			'headers' => DOMUtils::findHttpEquivHeaders( $doc ),
			// Prefer the passed in content model
			'contentmodel' => $pb->contentmodel ?? $pageConfig->getContentModel(),
			'offsetType' => $env->getCurrentOffsetType(),
		] );
	}

	/**
	 * Check whether a given content version can be downgraded to the requested
	 * content version.
	 *
	 * @param string $from Current content version
	 * @param string $to Requested content version
	 * @return string[]|null The downgrade that will fulfill the request, as
	 *   [ 'from' => <old version>, 'to' => <new version> ], or null if it
	 *   can't be fulfilled.
	 */
	public static function findDowngrade( string $from, string $to ): ?array {
		foreach ( self::DOWNGRADES as [ 'from' => $dgFrom, 'to' => $dgTo ] ) {
			if (
				Semver::satisfies( $from, "^$dgFrom" ) &&
				Semver::satisfies( $to, "^$dgTo" )
			) {
				// FIXME: Make this a class?
				return [ 'from' => $dgFrom, 'to' => $dgTo ];
			}
		}
		return null;
	}

	/**
	 * Downgrade a document to an older content version.
	 *
	 * @param string[] $dg Value returned by findDowngrade().
	 * @param HtmlPageBundle $pageBundle
	 */
	public static function downgrade(
		array $dg, HtmlPageBundle $pageBundle, ?SiteConfig $siteConfig = null
	): void {
		if ( $siteConfig === null ) {
			PHPUtils::deprecated( __METHOD__ . ' without siteConfig', '0.23' );
			$siteConfig = new MockSiteConfig( [] );
		}
		foreach ( self::DOWNGRADES as [ 'from' => $dgFrom, 'to' => $dgTo, 'func' => $dgFunc ] ) {
			if ( $dg['from'] === $dgFrom && $dg['to'] === $dgTo ) {
				self::$dgFunc( $pageBundle, $siteConfig );

				// FIXME: Maybe this resolve should just be part of the $dg
				$pageBundle->version = self::resolveContentVersion( $dg['to'] );

				// FIXME: Maybe this should be a helper to avoid the rt
				$doc = DOMUtils::parseHTML( $pageBundle->html );
				// Match the http-equiv meta to the content-type header
				$meta = DOMCompat::querySelector( $doc,
					'meta[property="mw:htmlVersion"], meta[property="mw:html:version"]' );
				if ( $meta ) {
					$meta->setAttribute( 'content', $pageBundle->version );
					$pageBundle->html = ContentUtils::toXML( $doc );
				}

				return;
			}
		}
		throw new InvalidArgumentException(
			"Unsupported downgrade: {$dg['from']} -> {$dg['to']}"
		);
	}

	/**
	 * Check if language variant conversion is implemented for a language
	 *
	 * @internal FIXME: Remove once Parsoid's language variant work is completed
	 * @param PageConfig $pageConfig
	 * @param Bcp47Code $htmlVariant Variant language to check
	 * @return bool
	 */
	public function implementsLanguageConversionBcp47( PageConfig $pageConfig, Bcp47Code $htmlVariant ): bool {
		// Hardcode disable zh lang conversion support since Parsoid's
		// implementation is incomplete and not performant (T346657).
		if ( $pageConfig->getPageLanguageBcp47()->toBcp47Code() === 'zh' ) {
			return false;
		}

		$metadata = new StubMetadataCollector( $this->siteConfig );
		$env = new Env( $this->siteConfig, $pageConfig, $this->dataAccess, $metadata );
		return LanguageConverter::implementsLanguageConversionBcp47( $env, $htmlVariant );
	}

	/**
	 * Downgrade the given document and pagebundle from 999.x to 2.x.
	 *
	 * @param HtmlPageBundle $pageBundle
	 */
	private static function downgrade999to2( HtmlPageBundle $pageBundle, SiteConfig $siteConfig ): void {
		// Effectively, skip applying data-parsoid.  Note that if we were to
		// support a pb2html downgrade, we'd need to apply the full thing,
		// but that would create complications where ids would be left behind.
		// See the doc comment for `DomPageBundle::apply()`
		$newHtmlPageBundle = new HtmlPageBundle(
			$pageBundle->html,
			null,
			$pageBundle->mw
		);
		$pageBundle->html = $newHtmlPageBundle->toInlineAttributeHtml( siteConfig: $siteConfig );

		// Now, modify the pagebundle to the expected form.  This is important
		// since, at least in the serialization path, the original pb will be
		// applied to the modified content and its presence could cause lost
		// deletions.
		$pageBundle->mw = [ 'ids' => [] ];
	}

	/**
	 * Convert an input document in a variety of formats (page bundle, etc)
	 * to a "prepared and loaded" document suitable to be given to
	 * Env::setupTopLevelDoc()
	 * @param Document|HtmlPageBundle|DomPageBundle $topLevelDoc
	 * @return Document
	 */
	private static function prepareAndLoadDocOrBundle( $topLevelDoc ): Document {
		// Recognize a "single document" page bundle.
		if (
			$topLevelDoc instanceof Document &&
			DomPageBundle::isSingleDocument( $topLevelDoc )
		) {
			$topLevelDoc = DomPageBundle::fromSingleDocument( $topLevelDoc );
		}
		// Convert a HtmlPageBundle (string html) to a DomPageBundle (DOM)
		if ( $topLevelDoc instanceof HtmlPageBundle ) {
			$topLevelDoc = DomPageBundle::fromHtmlPageBundle( $topLevelDoc );
		}
		// Use DomPageBundle::toDom() to efficiently apply and load
		// (without necessarily having to add attributes to the DOM)
		if ( $topLevelDoc instanceof DomPageBundle ) {
			// Skip preparation and loading, it's already done.
			return $topLevelDoc->toDom();
		}

		// This is an unprepared/unloaded Document.
		Assert::invariant(
			!DOMDataUtils::isPreparedAndLoaded( $topLevelDoc ),
			"toplevelDoc should not be prepared and loaded already"
		);
		DOMDataUtils::prepareDoc( $topLevelDoc );
		DOMDataUtils::visitAndLoadDataAttribs( DOMCompat::getBody( $topLevelDoc ) );
		// Mark the document as loaded so we can try to catch errors which
		// might try to reload this again later.
		DOMDataUtils::getBag( $topLevelDoc )->loaded = true;
		return $topLevelDoc;
	}

}
