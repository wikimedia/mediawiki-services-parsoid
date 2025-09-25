<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Config;

use Closure;
use Wikimedia\Assert\Assert;
use Wikimedia\Bcp47Code\Bcp47Code;
use Wikimedia\Parsoid\Core\ContentMetadataCollector;
use Wikimedia\Parsoid\Core\ContentModelHandler;
use Wikimedia\Parsoid\Core\DomPageBundle;
use Wikimedia\Parsoid\Core\ResourceLimitExceededException;
use Wikimedia\Parsoid\Core\Sanitizer;
use Wikimedia\Parsoid\Core\TOCData;
use Wikimedia\Parsoid\DOM\Document;
use Wikimedia\Parsoid\Fragments\PFragment;
use Wikimedia\Parsoid\Logger\ParsoidLogger;
use Wikimedia\Parsoid\Parsoid;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Utils\DOMCompat;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Utils\Title;
use Wikimedia\Parsoid\Utils\TitleException;
use Wikimedia\Parsoid\Utils\TokenUtils;
use Wikimedia\Parsoid\Utils\UrlUtils;
use Wikimedia\Parsoid\Utils\Utils;
use Wikimedia\Parsoid\Wikitext\ContentModelHandler as WikitextContentModelHandler;
use Wikimedia\Parsoid\Wt2Html\Frame;
use Wikimedia\Parsoid\Wt2Html\PageConfigFrame;
use Wikimedia\Parsoid\Wt2Html\ParserPipelineFactory;
use Wikimedia\Parsoid\Wt2Html\PipelineContentCache;
use Wikimedia\Parsoid\Wt2Html\TreeBuilder\RemexPipeline;

/**
 * Environment/Envelope class for Parsoid
 *
 * Carries around the SiteConfig and PageConfig during an operation
 * and provides certain other services.
 */
class Env {
	private SiteConfig $siteConfig;
	private PageConfig $pageConfig;
	private DataAccess $dataAccess;
	private ContentMetadataCollector $metadata;

	/** Table of Contents metadata for the article */
	private TOCData $tocData;

	/**
	 * The top-level frame for this conversion.
	 * This largely wraps the PageConfig.
	 * In the future we may replace PageConfig with the Frame
	 */
	public Frame $topFrame;
	// XXX In the future, perhaps replace PageConfig with the Frame, and
	// add $this->currentFrame (relocated from TokenHandlerPipeline) if/when
	// we've removed async parsing.

	/**
	 * Are we using native template expansion?
	 *
	 * Parsoid implements native template expansion, which is currently
	 * only used during parser tests; in production, template expansion
	 * is done via MediaWiki's legacy preprocessor.
	 *
	 * FIXME: Hopefully this distinction can be removed when we're entirely
	 * in PHP land.
	 */
	private bool $nativeTemplateExpansion;

	/** @var array<string,int> */
	private array $wt2htmlUsage = [];

	/** @var array<string,int> */
	private array $html2wtUsage = [];
	private bool $profiling = false;

	/** @var array<Profile> */
	private array $profileStack = [];
	private bool $wrapSections;

	/** @var ('byte'|'ucs2'|'char') */
	private string $requestOffsetType = 'byte';

	/** @var ('byte'|'ucs2'|'char') */
	private string $currentOffsetType = 'byte';
	private bool $skipLanguageConversionPass = false;

	/** @var array<string,mixed> */
	private array $behaviorSwitches = [];

	/**
	 * Maps pfragment id to a PFragment.
	 * @var array<string,PFragment>
	 */
	private array $pFragmentMap = [];

	/** Lints recorded */
	private array $lints = [];
	public bool $logLinterData = false;
	private array $linterOverrides = [];

	/** @var bool[] */
	private array $traceFlags;

	/** @var bool[] */
	private array $dumpFlags;

	/** @var bool[] */
	private array $debugFlags;
	private ParsoidLogger $parsoidLogger;

	/**
	 * The default content version that Parsoid assumes it's serializing or
	 * updating in the pb2pb endpoints
	 */
	private string $inputContentVersion;

	/**
	 * The default content version that Parsoid will generate.
	 */
	private string $outputContentVersion;

	/**
	 * If non-null, the language variant used for Parsoid HTML;
	 * we convert to this if wt2html, or from this if html2wt.
	 */
	private ?Bcp47Code $htmlVariantLanguage;

	/**
	 * If non-null, the language variant to be used for wikitext.
	 * If null, heuristics will be used to identify the original wikitext variant
	 * in wt2html mode, and in html2wt mode new or edited HTML will be left unconverted.
	 */
	private ?Bcp47Code $wtVariantLanguage;
	private ParserPipelineFactory $pipelineFactory;

	/**
	 * FIXME Used in DedupeStyles::dedupe()
	 */
	public array $styleTagKeys = [];

	/**
	 * The DomPageBundle holding the JSON data for data-parsoid and data-mw
	 * attributes, or `null` if these are to be encoded as inline HTML
	 * attributes.
	 */
	public ?DomPageBundle $pageBundle = null;
	private ?Document $domDiff = null;
	public bool $hasAnnotations = false;

	/**
	 * Cache of wikitext source for a title; only used for ParserTests.
	 */
	public array $pageCache = [];

	/**
	 * Token caches used in the pipeline
	 * @var array<PipelineContentCache>
	 */
	private array $pipelineContentCaches = [];

	/**
	 * The current top-level document. During wt2html, this will be the document
	 * associated with the RemexPipeline. During html2wt, this will be the
	 * input document, typically passed as a constructor option.
	 *
	 * This document should be prepared and loaded; see
	 * ContentUtils::createAndLoadDocument().
	 */
	private Document $topLevelDoc;

	/**
	 * The RemexPipeline used during a wt2html operation.
	 */
	private ?RemexPipeline $remexPipeline;
	private WikitextContentModelHandler $wikitextContentModelHandler;
	private ?Title $cachedContextTitle = null;

	/**
	 * @param SiteConfig $siteConfig
	 * @param PageConfig $pageConfig
	 * @param DataAccess $dataAccess
	 * @param ContentMetadataCollector $metadata
	 * @param ?array $options
	 *  - wrapSections: (bool) Whether `<section>` wrappers should be added.
	 *  - pageBundle: (bool) When true, sets ids on nodes and stores
	 *      data-* attributes in a JSON blob in Env::$pageBundle
	 *  - traceFlags: (array) Flags indicating which components need to be traced
	 *  - dumpFlags: (bool[]) Dump flags
	 *  - debugFlags: (bool[]) Debug flags
	 *  - nativeTemplateExpansion: boolean
	 *  - offsetType: 'byte' (default), 'ucs2', 'char'
	 *                See `Parsoid\Wt2Html\DOM\Processors\ConvertOffsets`.
	 *  - logLinterData: (bool) Should we log linter data if linting is enabled?
	 *  - linterOverrides: (array) Override the site linting configs.
	 *  - skipLanguageConversionPass: (bool) Should we skip the language
	 *      conversion pass? (defaults to false)
	 *  - htmlVariantLanguage: Bcp47Code|null
	 *      If non-null, the language variant used for Parsoid HTML
	 *      as a BCP 47 object.
	 *      We convert to this if wt2html, or from this if html2wt.
	 *  - wtVariantLanguage: Bcp47Code|null
	 *      If non-null, the language variant to be used for wikitext
	 *      as a BCP 47 object.
	 *      If null, heuristics will be used to identify the original
	 *      wikitext variant in wt2html mode, and in html2wt mode new
	 *      or edited HTML will be left unconverted.
	 *  - logLevels: (string[]) Levels to log
	 *  - topLevelDoc: Document Set explicitly
	 *      when serializing otherwise it gets initialized for parsing.
	 *      This should be a "prepared & loaded" document.
	 */
	public function __construct(
		SiteConfig $siteConfig,
		PageConfig $pageConfig,
		DataAccess $dataAccess,
		ContentMetadataCollector $metadata,
		?array $options = null
	) {
		$options ??= [];
		$this->siteConfig = $siteConfig;
		$this->pageConfig = $pageConfig;
		$this->dataAccess = $dataAccess;
		$this->metadata = $metadata;
		$this->tocData = new TOCData();
		$this->topFrame = new PageConfigFrame( $this, $pageConfig, $siteConfig );
		$this->wrapSections = (bool)( $options['wrapSections'] ?? true );
		$this->pipelineFactory = new ParserPipelineFactory( $this );
		$defaultContentVersion = Parsoid::defaultHTMLVersion();
		$this->inputContentVersion = $options['inputContentVersion'] ?? $defaultContentVersion;
		// FIXME: We should have a check for the supported input content versions as well.
		// That will require a separate constant.
		$this->outputContentVersion = $options['outputContentVersion'] ?? $defaultContentVersion;
		if ( !in_array( $this->outputContentVersion, Parsoid::AVAILABLE_VERSIONS, true ) ) {
			throw new \UnexpectedValueException(
				$this->outputContentVersion . ' is not an available content version.' );
		}
		$this->skipLanguageConversionPass =
			$options['skipLanguageConversionPass'] ?? false;
		$this->htmlVariantLanguage = $options['htmlVariantLanguage'] ?? null;
		$this->wtVariantLanguage = $options['wtVariantLanguage'] ?? null;
		$this->nativeTemplateExpansion = !empty( $options['nativeTemplateExpansion'] );
		$this->requestOffsetType = $options['offsetType'] ?? 'byte';
		$this->logLinterData = !empty( $options['logLinterData'] );
		$this->linterOverrides = $options['linterOverrides'] ?? [];
		$this->setupTopLevelDoc( $options['topLevelDoc'] ?? null );
		if ( $options['pageBundle'] ?? false ) {
			$this->pageBundle = DomPageBundle::newEmpty(
				$this->topLevelDoc
			);
		}
		// NOTE:
		// Don't try to do this in setupTopLevelDoc since it is called on existing Env objects
		// in a couple of places. That then leads to a multiple-write to tocdata property on
		// the metadata object.
		//
		// setupTopLevelDoc is called outside Env in these couple cases:
		// 1. html2wt in ContentModelHandler for dealing with
		//    missing original HTML.
		// 2. ParserTestRunner's html2html tests
		//
		// That is done to either reuse an existing Env object (as in 1.)
		// OR to refresh the attached DOC (html2html as in 2.).
		// Constructing a new Env in both cases could eliminate this issue.
		$this->metadata->setTOCData( $this->tocData );

		$this->traceFlags = $options['traceFlags'] ?? [];
		$this->dumpFlags = $options['dumpFlags'] ?? [];
		$this->debugFlags = $options['debugFlags'] ?? [];
		$this->parsoidLogger = new ParsoidLogger( $this->siteConfig->getLogger(), [
			'logLevels' => $options['logLevels'] ?? [ 'fatal', 'error', 'warn', 'info' ],
			'debugFlags' => $this->debugFlags,
			'dumpFlags' => $this->dumpFlags,
			'traceFlags' => $this->traceFlags,
			'ownerDoc' => $this->getTopLevelDoc(),
		] );
		if ( $this->hasTraceFlag( 'time' ) ) {
			$this->profiling = true;
		}

		$this->wikitextContentModelHandler = new WikitextContentModelHandler( $this );
	}

	/**
	 * Is profiling enabled?
	 * @return bool
	 */
	public function profiling(): bool {
		return $this->profiling;
	}

	/**
	 * Get the profile at the top of the stack
	 *
	 * FIXME: This implicitly assumes sequential in-order processing
	 * This wouldn't have worked in Parsoid/JS and may not work in the future
	 * depending on how / if we restructure the pipeline for concurrency, etc.
	 *
	 * @return Profile
	 */
	public function getCurrentProfile(): Profile {
		return PHPUtils::lastItem( $this->profileStack );
	}

	/**
	 * New pipeline started. Push profile.
	 * @return Profile
	 */
	public function pushNewProfile(): Profile {
		$currProfile = count( $this->profileStack ) > 0 ? $this->getCurrentProfile() : null;
		$profile = new Profile( $this, isset( $this->debugFlags['oom'] ) );
		$this->profileStack[] = $profile;
		if ( $currProfile !== null ) {
			$currProfile->pushNestedProfile( $profile );
		}
		return $profile;
	}

	/**
	 * Pipeline ended. Pop profile.
	 * @return Profile
	 */
	public function popProfile(): Profile {
		return array_pop( $this->profileStack );
	}

	public function hasTraceFlags(): bool {
		return !empty( $this->traceFlags );
	}

	/**
	 * Test which trace information to log
	 *
	 * @param string $flag Flag name.
	 * @return bool
	 */
	public function hasTraceFlag( string $flag ): bool {
		return isset( $this->traceFlags[$flag] );
	}

	public function hasDumpFlags(): bool {
		return !empty( $this->dumpFlags );
	}

	/**
	 * Test which state to dump
	 *
	 * @param string $flag Flag name.
	 * @return bool
	 */
	public function hasDumpFlag( string $flag ): bool {
		return isset( $this->dumpFlags[$flag] );
	}

	/**
	 * Write out a string (because it was requested by dumpFlags)
	 *
	 * @param string $str
	 */
	public function writeDump( string $str ): void {
		$this->log( 'dump', $str );
	}

	/**
	 * Get the site config
	 * @return SiteConfig
	 */
	public function getSiteConfig(): SiteConfig {
		return $this->siteConfig;
	}

	/**
	 * Get the page config
	 * @return PageConfig
	 */
	public function getPageConfig(): PageConfig {
		return $this->pageConfig;
	}

	/**
	 * Get the data access object
	 * @return DataAccess
	 */
	public function getDataAccess(): DataAccess {
		return $this->dataAccess;
	}

	/**
	 * Return the ContentMetadataCollector.
	 * @return ContentMetadataCollector
	 */
	public function getMetadata(): ContentMetadataCollector {
		return $this->metadata;
	}

	/**
	 * Return the Table of Contents information for the article.
	 * @return TOCData
	 */
	public function getTOCData(): TOCData {
		return $this->tocData;
	}

	public function nativeTemplateExpansionEnabled(): bool {
		return $this->nativeTemplateExpansion;
	}

	/**
	 * Whether `<section>` wrappers should be added.
	 * @todo Does this actually belong here? Should it be a behavior switch?
	 * @return bool
	 */
	public function getWrapSections(): bool {
		return $this->wrapSections;
	}

	/**
	 * Get the pipeline factory.
	 * @return ParserPipelineFactory
	 */
	public function getPipelineFactory(): ParserPipelineFactory {
		return $this->pipelineFactory;
	}

	/**
	 * Get a token cache for a given cache name. A cache is shared across all pipelines
	 * and processing that happens in the lifetime of this Env object.
	 * @param string $cacheName Key to retrieve a token cache
	 * @param array{repeatThreshold:int,cloneValue:bool|Closure} $newCacheOpts Opts for the new cache
	 */
	public function getCache( string $cacheName, array $newCacheOpts ): PipelineContentCache {
		if ( !isset( $this->pipelineContentCaches[$cacheName] ) ) {
			$this->pipelineContentCaches[$cacheName] = new PipelineContentCache(
				$newCacheOpts['repeatThreshold'],
				$newCacheOpts['cloneValue']
			);
		}

		return $this->pipelineContentCaches[$cacheName];
	}

	/**
	 * Return the external format of character offsets in source ranges.
	 * Internally we always keep DomSourceRange and SourceRange information
	 * as UTF-8 byte offsets for efficiency (matches the native string
	 * representation), but for external use we can convert these to
	 * other formats when we output wt2html or input for html2wt.
	 *
	 * @see Parsoid\Wt2Html\DOM\Processors\ConvertOffsets
	 * @return ('byte'|'ucs2'|'char')
	 */
	public function getRequestOffsetType(): string {
		return $this->requestOffsetType;
	}

	/**
	 * Return the current format of character offsets in source ranges.
	 * This allows us to track whether the internal byte offsets have
	 * been converted to the external format (as returned by
	 * `getRequestOffsetType`) yet.
	 *
	 * @see Parsoid\Wt2Html\DOM\Processors\ConvertOffsets
	 * @return ('byte'|'ucs2'|'char')
	 */
	public function getCurrentOffsetType(): string {
		return $this->currentOffsetType;
	}

	/**
	 * Update the current offset type. Only
	 * Parsoid\Wt2Html\DOM\Processors\ConvertOffsets should be doing this.
	 *
	 * @param ('byte'|'ucs2'|'char') $offsetType 'byte', 'ucs2', or 'char'
	 */
	public function setCurrentOffsetType( string $offsetType ): void {
		$this->currentOffsetType = $offsetType;
	}

	/**
	 * Return the title from the PageConfig, as a Parsoid title.
	 * @return Title
	 */
	public function getContextTitle(): Title {
		if ( $this->cachedContextTitle === null ) {
			$this->cachedContextTitle = Title::newFromLinkTarget(
				$this->pageConfig->getLinkTarget(), $this->siteConfig
			);
		}
		return $this->cachedContextTitle;
	}

	/**
	 * Resolve strings that are page-fragments or subpage references with
	 * respect to the current page name.
	 *
	 * @param string $str Page fragment or subpage reference. Not URL encoded.
	 * @param bool $resolveOnly If true, only trim and add the current title to
	 *  lone fragments. TODO: This parameter seems poorly named.
	 * @return string Resolved title
	 */
	public function resolveTitle( string $str, bool $resolveOnly = false ): string {
		$origName = $str;
		$str = trim( $str );

		$title = $this->getContextTitle();

		// Resolve lonely fragments (important if the current page is a subpage,
		// otherwise the relative link will be wrong)
		if ( $str !== '' && $str[0] === '#' ) {
			return $title->getPrefixedText() . $str;
		}

		// Default return value
		$titleKey = $str;
		if ( $this->getSiteConfig()->namespaceHasSubpages( $title->getNamespace() ) ) {
			// Resolve subpages
			$reNormalize = false;
			if ( preg_match( '!^(?:\.\./)+!', $str, $relUp ) ) {
				$levels = strlen( $relUp[0] ) / 3;  // Levels are indicated by '../'.
				$titleBits = explode( '/', $title->getPrefixedText() );
				if ( $titleBits[0] === '' ) {
					// FIXME: Punt on subpages of titles starting with "/" for now
					return $origName;
				}
				if ( count( $titleBits ) <= $levels ) {
					// Too many levels -- invalid relative link
					return $origName;
				}
				$newBits = array_slice( $titleBits, 0, -$levels );
				if ( $str !== $relUp[0] ) {
					$newBits[] = substr( $str, $levels * 3 );
				}
				$str = implode( '/', $newBits );
				$reNormalize = true;
			} elseif ( $str !== '' && $str[0] === '/' ) {
				// Resolve absolute subpage links
				$str = $title->getPrefixedText() . $str;
				$reNormalize = true;
			}

			if ( $reNormalize && !$resolveOnly ) {
				// Remove final slashes if present.
				// See https://gerrit.wikimedia.org/r/173431
				$str = rtrim( $str, '/' );
				$titleKey = (string)$this->normalizedTitleKey( $str );
			}
		}

		// Strip leading ':'
		if ( $titleKey !== '' && $titleKey[0] === ':' && !$resolveOnly ) {
			$titleKey = substr( $titleKey, 1 );
		}
		return $titleKey;
	}

	/**
	 * Get normalized title key for a title string.
	 *
	 * @param string $str Should be in url-decoded format.
	 * @param bool $noExceptions Return null instead of throwing exceptions.
	 * @param bool $ignoreFragment Ignore the fragment, if any.
	 * @return string|null Normalized title key for a title string (or null for invalid titles).
	 */
	public function normalizedTitleKey(
		string $str, bool $noExceptions = false, bool $ignoreFragment = false
	): ?string {
		$title = $this->makeTitleFromURLDecodedStr( $str, 0, $noExceptions );
		if ( !$title ) {
			return null;
		}
		return $ignoreFragment ?
			$title->getPrefixedDBKey() :
			$title->getFullDBKey();
	}

	/**
	 * Create a Title object
	 * @param string $text URL-decoded text
	 * @param ?int $defaultNs
	 * @param bool $noExceptions
	 * @return Title|null
	 */
	private function makeTitle( string $text, ?int $defaultNs = null, bool $noExceptions = false ): ?Title {
		try {
			if ( preg_match( '!^(?:[#/]|\.\./)!', $text ) ) {
				$defaultNs = $this->getContextTitle()->getNamespace();
			}
			$text = $this->resolveTitle( $text );
			return Title::newFromText( $text, $this->getSiteConfig(), $defaultNs );
		} catch ( TitleException $e ) {
			if ( $noExceptions ) {
				return null;
			}
			throw $e;
		}
	}

	/**
	 * Create a Title object
	 * @see Title::newFromURL in MediaWiki
	 * @param string $str URL-encoded text
	 * @param ?int $defaultNs
	 * @param bool $noExceptions
	 * @return Title|null
	 */
	public function makeTitleFromText(
		string $str, ?int $defaultNs = null, bool $noExceptions = false
	): ?Title {
		return $this->makeTitle( Utils::decodeURIComponent( $str ), $defaultNs, $noExceptions );
	}

	/**
	 * Create a Title object
	 * @see Title::newFromText in MediaWiki
	 * @param string $str URL-decoded text
	 * @param ?int $defaultNs
	 * @param bool $noExceptions
	 * @return Title|null
	 */
	public function makeTitleFromURLDecodedStr(
		string $str, ?int $defaultNs = null, bool $noExceptions = false
	): ?Title {
		return $this->makeTitle( $str, $defaultNs, $noExceptions );
	}

	/**
	 * Make a link to a local Title
	 * @param Title $title
	 * @return string
	 */
	public function makeLink( Title $title ): string {
		// T380676: This method *should* be used only for local titles,
		// (ie $title->getInterwiki() should be '') but apparently we
		// are using it for interwiki/interlanguage links as well.
		return $this->getSiteConfig()->relativeLinkPrefix() . Sanitizer::sanitizeTitleURI(
			$title->getFullDBKey(),
			false
		);
	}

	/**
	 * Test if an href attribute value could be a valid link target
	 * @param string|(Token|string)[] $href
	 * @return bool
	 */
	public function isValidLinkTarget( $href ): bool {
		$href = TokenUtils::tokensToString( $href );

		// decode percent-encoding so that we can reliably detect
		// bad page title characters
		$hrefToken = Utils::decodeURIComponent( $href );
		return $this->normalizedTitleKey( $this->resolveTitle( $hrefToken, true ), true ) !== null;
	}

	/**
	 * Generate a new annotation id
	 * @return string
	 */
	public function newAnnotationId(): string {
		return DOMDataUtils::getBag( $this->topLevelDoc )->newAnnotationId();
	}

	/**
	 * Generate a new about id
	 * @return string
	 */
	public function newAboutId(): string {
		return DOMDataUtils::getBag( $this->topLevelDoc )->newAboutId();
	}

	/**
	 * Store reference to DOM diff document
	 * @param Document $doc
	 */
	public function setDOMDiff( $doc ): void {
		$this->domDiff = $doc;
	}

	/**
	 * Return reference to DOM diff document
	 * @return Document|null
	 */
	public function getDOMDiff(): ?Document {
		return $this->domDiff;
	}

	/**
	 * When an environment is constructed, we initialize a document (and
	 * RemexPipeline) to be used throughout the parse.
	 *
	 * @param ?Document $topLevelDoc if non-null,
	 *  the document should be prepared and loaded.
	 */
	public function setupTopLevelDoc( ?Document $topLevelDoc = null ): void {
		if ( $topLevelDoc ) {
			$this->remexPipeline = null;
			// This is a prepared & loaded Document.
			Assert::invariant(
				DOMDataUtils::isPreparedAndLoaded( $topLevelDoc ),
				"toplevelDoc should be prepared and loaded already"
			);
			$this->topLevelDoc = $topLevelDoc;
		} else {
			$this->topLevelDoc = DOMCompat::newDocument( isHtml: true );
			$documentElement = $this->topLevelDoc->documentElement;
			if ( !$documentElement ) {
				$documentElement = $this->topLevelDoc->createElement( 'html' );
				$this->topLevelDoc->appendChild( $documentElement );
			}
			$body = DOMCompat::getBody( $this->topLevelDoc );
			if ( !$body ) {
				$body = $this->topLevelDoc->createElement( 'body' );
				$documentElement->appendChild( $body );
			}
			$this->remexPipeline = new RemexPipeline( $this );
			// Prepare and load.
			// (Loading should be easy since the doc is expected to be empty.)
			$options = [
				'validateXMLNames' => true,
				 // Don't mark the <body> tag as new!
				'markNew' => false,
			];
			DOMDataUtils::prepareDoc( $this->topLevelDoc );
			DOMDataUtils::visitAndLoadDataAttribs(
				$body, $options
			);
			// Mark the document as loaded so we can try to catch errors which
			// might try to reload this again later.
			DOMDataUtils::getBag( $this->topLevelDoc )->loaded = true;
		}
	}

	/**
	 * Return the current top-level document. During wt2html, this
	 * will be the document associated with the RemexPipeline. During
	 * html2wt, this will be the input document, typically passed as a
	 * constructor option.
	 *
	 * This document will be prepared and loaded; see
	 * ContentUtils::createAndLoadDocument().
	 */
	public function getTopLevelDoc(): Document {
		return $this->topLevelDoc;
	}

	public function fetchRemexPipeline( bool $toFragment ): RemexPipeline {
		if ( !$toFragment ) {
			return $this->remexPipeline;
		} else {
			return new RemexPipeline( $this );
		}
	}

	/**
	 * Record a behavior switch.
	 *
	 * @param string $switch Switch name
	 * @param mixed $state Relevant state data to record
	 */
	public function setBehaviorSwitch( string $switch, $state ): void {
		$this->behaviorSwitches[$switch] = $state;
	}

	/**
	 * Fetch the state of a previously-recorded behavior switch.
	 *
	 * @param string $switch Switch name
	 * @param mixed $default Default value if the switch was never set
	 * @return mixed State data that was previously passed to setBehaviorSwitch(), or $default
	 */
	public function getBehaviorSwitch( string $switch, $default = null ) {
		return $this->behaviorSwitches[$switch] ?? $default;
	}

	public function getPFragment( string $id ): PFragment {
		return $this->pFragmentMap[$id];
	}

	/** @param array<string,PFragment> $mapping */
	public function addToPFragmentMap( array $mapping ): void {
		$this->pFragmentMap += $mapping;
	}

	/**
	 * @internal
	 * Serialize pfragment map to string for debugging dumps
	 */
	public function pFragmentMapToString(): string {
		$codec = DOMDataUtils::getCodec( $this->getTopLevelDoc() );
		$buf = '';
		foreach ( $this->pFragmentMap as $k => $v ) {
			$buf .= "$k = " . $codec->toJsonString( $v, PFragment::hint() );
		}
		return $buf;
	}

	/**
	 * Record a lint
	 * @param string $type Lint type key
	 * @param array $lintData Data for the lint.
	 *  - dsr: (SourceRange)
	 *  - params: (array)
	 *  - templateInfo: (array|null)
	 */
	public function recordLint( string $type, array $lintData ): void {
		if ( !$this->linting( $type ) ) {
			return;
		}

		if ( empty( $lintData['dsr'] ) ) {
			$this->log( 'error/lint', "Missing DSR; msg=", $lintData );
			return;
		}
		$source = $lintData['dsr']?->source ?? $this->topFrame->getSource();
		if ( $source !== $this->topFrame->getSource() ) {
			$this->log( 'error/lint', "Bad source; msg=", $lintData );
			return;
		}

		// This will always be recorded as a native 'byte' offset
		$lintData['dsr'] = $lintData['dsr']->toJsonArray();
		$lintData['params'] ??= [];

		$this->lints[] = [ 'type' => $type ] + $lintData;
	}

	/**
	 * Retrieve recorded lints
	 * @return array[]
	 */
	public function getLints(): array {
		return $this->lints;
	}

	/**
	 * Init lints to the passed array.
	 *
	 * FIXME: This is currently needed to reset lints after converting
	 * DSR offsets because of ordering of DOM passes. So, in reality,
	 * there should be no real use case for setting this anywhere else
	 * but from that single callsite.
	 *
	 * @param array $lints
	 */
	public function setLints( array $lints ): void {
		$this->lints = $lints;
	}

	/**
	 * @param string $prefix
	 * @param mixed ...$args
	 */
	public function log( string $prefix, ...$args ): void {
		$this->parsoidLogger->log( $prefix, ...$args );
	}

	/**
	 * Shortcut helper that also allows early exit if tracing is not enabled.
	 * @param string $prefix
	 * @param mixed ...$args
	 */
	public function trace( string $prefix, ...$args ): void {
		if ( $this->traceFlags ) {
			$this->parsoidLogger->log( $prefix ? "trace/$prefix" : "trace", ...$args );
		}
	}

	/**
	 * Bump usage of some limited parser resource
	 * (ex: tokens, # transclusions, # list items, etc.)
	 *
	 * @param string $resource
	 * @param int $count How much of the resource is used?
	 * @return ?bool Returns `null` if the limit was already reached, `false` when exceeded
	 */
	public function bumpWt2HtmlResourceUse( string $resource, int $count = 1 ): ?bool {
		$n = $this->wt2htmlUsage[$resource] ?? 0;
		if ( !$this->compareWt2HtmlLimit( $resource, $n ) ) {
			return null;
		}
		$n += $count;
		$this->wt2htmlUsage[$resource] = $n;
		return $this->compareWt2HtmlLimit( $resource, $n );
	}

	/**
	 * @param string $resource
	 * @param int $n
	 * @return bool Return `false` when exceeded
	 */
	public function compareWt2HtmlLimit( string $resource, int $n ): bool {
		$wt2htmlLimits = $this->siteConfig->getWt2HtmlLimits();
		return !( isset( $wt2htmlLimits[$resource] ) && $n > $wt2htmlLimits[$resource] );
	}

	/**
	 * Bump usage of some limited serializer resource
	 * (ex: html size)
	 *
	 * @param string $resource
	 * @param int $count How much of the resource is used? (defaults to 1)
	 * @throws ResourceLimitExceededException
	 */
	public function bumpHtml2WtResourceUse( string $resource, int $count = 1 ): void {
		$n = $this->html2wtUsage[$resource] ?? 0;
		$n += $count;
		$this->html2wtUsage[$resource] = $n;
		$html2wtLimits = $this->siteConfig->getHtml2WtLimits();
		if (
			isset( $html2wtLimits[$resource] ) &&
			$n > $html2wtLimits[$resource]
		) {
			throw new ResourceLimitExceededException( "html2wt: $resource limit exceeded: $n" );
		}
	}

	/**
	 * Get an appropriate content handler, given a contentmodel.
	 *
	 * @param ?string &$contentmodel An optional content model which
	 *   will override whatever the source specifies.  It gets set to the
	 *   handler which is used.
	 * @return ContentModelHandler An appropriate content handler
	 */
	public function getContentHandler(
		?string &$contentmodel = null
	): ContentModelHandler {
		$contentmodel ??= $this->pageConfig->getContentModel();
		$handler = $this->siteConfig->getContentModelHandler( $contentmodel );
		if ( !$handler && $contentmodel !== 'wikitext' ) {
			// For now, fallback to 'wikitext' as the default handler
			// FIXME: This is bogus, but this is just so suppress noise in our
			// logs till we get around to handling all these other content models.
			// $this->log( 'warn', "Unknown contentmodel $contentmodel" );
		}
		return $handler ?? $this->wikitextContentModelHandler;
	}

	/**
	 * Is the language converter enabled on this page?
	 *
	 * @return bool
	 */
	public function langConverterEnabled(): bool {
		return $this->siteConfig->langConverterEnabledBcp47(
			$this->pageConfig->getPageLanguageBcp47()
		);
	}

	/**
	 * The HTML content version of the input document (for html2wt and html2html conversions).
	 * @see https://www.mediawiki.org/wiki/Parsoid/API#Content_Negotiation
	 * @see https://www.mediawiki.org/wiki/Specs/HTML#Versioning
	 * @return string A semver version number
	 */
	public function getInputContentVersion(): string {
		return $this->inputContentVersion;
	}

	/**
	 * The HTML content version of the input document (for html2wt and html2html conversions).
	 * @see https://www.mediawiki.org/wiki/Parsoid/API#Content_Negotiation
	 * @see https://www.mediawiki.org/wiki/Specs/HTML#Versioning
	 * @return string A semver version number
	 */
	public function getOutputContentVersion(): string {
		return $this->outputContentVersion;
	}

	/**
	 * If non-null, the language variant used for Parsoid HTML; we convert
	 * to this if wt2html, or from this (if html2wt).
	 *
	 * @return ?Bcp47Code a BCP-47 language code
	 */
	public function getHtmlVariantLanguageBcp47(): ?Bcp47Code {
		return $this->htmlVariantLanguage; // Stored as BCP-47
	}

	/**
	 * If non-null, the language variant to be used for wikitext.  If null,
	 * heuristics will be used to identify the original wikitext variant
	 * in wt2html mode, and in html2wt mode new or edited HTML will be left
	 * unconverted.
	 *
	 * @return ?Bcp47Code a BCP-47 language code
	 */
	public function getWtVariantLanguageBcp47(): ?Bcp47Code {
		return $this->wtVariantLanguage;
	}

	public function getSkipLanguageConversionPass(): bool {
		return $this->skipLanguageConversionPass;
	}

	/**
	 * Determine appropriate vary headers for the HTML form of this page.
	 * @return string
	 */
	public function htmlVary(): string {
		$varies = [ 'Accept' ]; // varies on Content-Type
		if ( $this->langConverterEnabled() ) {
			$varies[] = 'Accept-Language';
		}

		sort( $varies );
		return implode( ', ', $varies );
	}

	/**
	 * Determine an appropriate content-language for the HTML form of this page.
	 * @return Bcp47Code a BCP-47 language code.
	 */
	public function htmlContentLanguageBcp47(): Bcp47Code {
		// PageConfig::htmlVariant is set iff we do variant conversion on the
		// HTML
		return $this->pageConfig->getVariantBcp47() ??
			$this->pageConfig->getPageLanguageBcp47();
	}

	/**
	 * Get an array of attributes to apply to an anchor linking to $url
	 *
	 * @return array{rel?: list<'nofollow'|'noopener'|'noreferrer'>, target?: string}
	 */
	public function getExternalLinkAttribs( string $url ): array {
		$siteConfig = $this->getSiteConfig();
		$noFollowConfig = $siteConfig->getNoFollowConfig();
		$attribs = [];
		$ns = $this->getContextTitle()->getNamespace();
		if (
			$noFollowConfig['nofollow'] &&
			!in_array( $ns, $noFollowConfig['nsexceptions'], true ) &&
			!UrlUtils::matchesDomainList(
				$url,
				// Cast to an array because parserTests sets it as a string
				(array)$noFollowConfig['domainexceptions']
			)
		) {
			$attribs['rel'] = [ 'nofollow' ];
		}
		$target = $siteConfig->getExternalLinkTarget();
		if ( $target ) {
			$attribs['target'] = $target;
			if ( !in_array( $target, [ '_self', '_parent', '_top' ], true ) ) {
				// T133507. New windows can navigate parent cross-origin.
				// Including noreferrer due to lacking browser
				// support of noopener. Eventually noreferrer should be removed.
				if ( !isset( $attribs['rel'] ) ) {
					$attribs['rel'] = [];
				}
				array_push( $attribs['rel'], 'noreferrer', 'noopener' );
			}
		}
		return $attribs;
	}

	/**
	 * @return array
	 */
	public function getLinterConfig(): array {
		return $this->linterOverrides + $this->getSiteConfig()->getLinterSiteConfig();
	}

	/**
	 * Whether to enable linter Backend.
	 * Consults the allow list and block list from ::getLinterConfig().
	 *
	 * @param string|null $type If $type is null or omitted, returns true if *any* linting
	 *   type is enabled; otherwise returns true only if the specified
	 *   linting type is enabled.
	 * @return bool If $type is null or omitted, returns true if *any* linting
	 *   type is enabled; otherwise returns true only if the specified
	 *   linting type is enabled.
	 */
	public function linting( ?string $type = null ) {
		if ( !$this->getSiteConfig()->linterEnabled() ) {
			return false;
		}
		$lintConfig = $this->getLinterConfig();
		// Allow list
		$allowList = $lintConfig['enabled'] ?? null;
		if ( is_array( $allowList ) ) {
			if ( $type === null ) {
				return count( $allowList ) > 0;
			}
			return in_array( $type, $allowList, true );
		}
		// Block list
		if ( $type === null ) {
			return true;
		}
		$blockList = $lintConfig['disabled'] ?? null;
		if ( is_array( $blockList ) ) {
			return !in_array( $type, $blockList, true );
		}
		// No specific configuration
		return true;
	}
}
