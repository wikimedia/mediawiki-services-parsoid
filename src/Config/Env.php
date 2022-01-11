<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Config;

use Wikimedia\Assert\Assert;
use Wikimedia\Parsoid\Core\ContentMetadataCollector;
use Wikimedia\Parsoid\Core\ContentModelHandler;
use Wikimedia\Parsoid\Core\ResourceLimitExceededException;
use Wikimedia\Parsoid\Core\Sanitizer;
use Wikimedia\Parsoid\DOM\Document;
use Wikimedia\Parsoid\DOM\DocumentFragment;
use Wikimedia\Parsoid\Logger\ParsoidLogger;
use Wikimedia\Parsoid\Parsoid;
use Wikimedia\Parsoid\Tokens\Token;
use Wikimedia\Parsoid\Utils\DOMDataUtils;
use Wikimedia\Parsoid\Utils\PHPUtils;
use Wikimedia\Parsoid\Utils\Title;
use Wikimedia\Parsoid\Utils\TitleException;
use Wikimedia\Parsoid\Utils\TitleNamespace;
use Wikimedia\Parsoid\Utils\TokenUtils;
use Wikimedia\Parsoid\Utils\Utils;
use Wikimedia\Parsoid\Wikitext\ContentModelHandler as WikitextContentModelHandler;
use Wikimedia\Parsoid\Wt2Html\Frame;
use Wikimedia\Parsoid\Wt2Html\PageConfigFrame;
use Wikimedia\Parsoid\Wt2Html\ParserPipelineFactory;
use Wikimedia\Parsoid\Wt2Html\TreeBuilder\RemexPipeline;

/**
 * Environment/Envelope class for Parsoid
 *
 * Carries around the SiteConfig and PageConfig during an operation
 * and provides certain other services.
 */
class Env {

	/** @var SiteConfig */
	private $siteConfig;

	/** @var PageConfig */
	private $pageConfig;

	/** @var DataAccess */
	private $dataAccess;

	/** @var ContentMetadataCollector */
	private $metadata;

	/**
	 * The top-level frame for this conversion.  This largely wraps the
	 * PageConfig.
	 *
	 * In the future we may replace PageConfig with the Frame, and add
	 * a
	 * @var Frame
	 */
	public $topFrame;
	// XXX In the future, perhaps replace PageConfig with the Frame, and
	// add $this->currentFrame (relocated from TokenTransformManager) if/when
	// we've removed async parsing.

	/**
	 * @var bool Are we using native template expansion?
	 *
	 * Parsoid implements native template expansion, which is currently
	 * only used during parser tests; in production, template expansion
	 * is done via MediaWiki's legacy preprocessor.
	 *
	 * FIXME: Hopefully this distinction can be removed when we're entirely
	 * in PHP land.
	 */
	private $nativeTemplateExpansion;

	/** @phan-var array<string,int> */
	private $wt2htmlUsage = [];

	/** @phan-var array<string,int> */
	private $html2wtUsage = [];

	/** @var bool */
	private $profiling = false;

	/** @var array<Profile> */
	private $profileStack = [];

	/** @var bool */
	private $wrapSections = true;

	/** @var string */
	private $requestOffsetType = 'byte';

	/** @var string */
	private $currentOffsetType = 'byte';

	/** @var array<string,mixed> */
	private $behaviorSwitches = [];

	/**
	 * Maps fragment id to the fragment forest (array of Nodes).
	 * @var array<string,DocumentFragment>
	 */
	private $fragmentMap = [];

	/**
	 * @var int used to generate fragment ids as needed during parse
	 */
	private $fid = 1;

	/** @var int used to generate uids as needed during this parse */
	private $uid = 1;

	/** @var int used to generate annotation uids as needed during this parse */
	private $annUid = 0;

	/** @var array[] Lints recorded */
	private $lints = [];

	/** @var bool logLinterData */
	public $logLinterData = false;

	/** @var bool[] */
	private $traceFlags;

	/** @var bool[] */
	private $dumpFlags;

	/** @var bool[] */
	private $debugFlags;

	/** @var ParsoidLogger */
	private $parsoidLogger;

	/**
	 * The default content version that Parsoid assumes it's serializing or
	 * updating in the pb2pb endpoints
	 *
	 * @var string
	 */
	private $inputContentVersion;

	/**
	 * The default content version that Parsoid will generate.
	 *
	 * @var string
	 */
	private $outputContentVersion;

	/**
	 * If non-null, the language variant used for Parsoid HTML;
	 * we convert to this if wt2html, or from this if html2wt.
	 * @var string
	 */
	private $htmlVariantLanguage;

	/**
	 * If non-null, the language variant to be used for wikitext.
	 * If null, heuristics will be used to identify the original wikitext variant
	 * in wt2html mode, and in html2wt mode new or edited HTML will be left unconverted.
	 * @var string
	 */
	private $wtVariantLanguage;

	/** @var ParserPipelineFactory */
	private $pipelineFactory;

	/**
	 * FIXME Used in DedupeStyles::dedupe()
	 * @var array
	 */
	public $styleTagKeys = [];

	/** @var bool */
	public $pageBundle = false;

	/** @var bool */
	public $discardDataParsoid = false;

	/** @var Document */
	private $domDiff;

	/** @var bool */
	public $hasAnnotations;

	/**
	 * PORT-FIXME: public currently
	 * Cache of wikitext source for a title
	 * @var array
	 */
	public $pageCache = [];

	/**
	 * PORT-FIXME: public currently
	 * HTML Cache of expanded transclusions to support
	 * reusing expansions from HTML of previous revision.
	 * @var array
	 */
	public $transclusionCache = [];

	/**
	 * PORT-FIXME: public currently
	 * HTML Cache of expanded media wikiext to support
	 * reusing expansions from HTML of previous revision.
	 * @var array
	 */
	public $mediaCache = [];

	/**
	 * PORT-FIXME: public currently
	 * HTML Cache of expanded extension tags to support
	 * reusing expansions from HTML of previous revision.
	 * @var array
	 */
	public $extensionCache = [];

	/**
	 * The current top-level document. During wt2html, this will be the document
	 * associated with the RemexPipeline. During html2wt, this will be the
	 * input document, typically passed as a constructor option.
	 *
	 * @var Document
	 */
	public $topLevelDoc;

	/**
	 * The RemexPipeline used during a wt2html operation.
	 *
	 * @var RemexPipeline|null
	 */
	private $remexPipeline;

	/**
	 * @var WikitextContentModelHandler
	 */
	private $wikitextContentModelHandler;

	/**
	 * @param SiteConfig $siteConfig
	 * @param PageConfig $pageConfig
	 * @param DataAccess $dataAccess
	 * @param ContentMetadataCollector $metadata
	 * @param ?array $options
	 *  - wrapSections: (bool) Whether `<section>` wrappers should be added.
	 *  - pageBundle: (bool) Sets ids on nodes and stores data-* attributes in a JSON blob.
	 *  - traceFlags: (array) Flags indicating which components need to be traced
	 *  - dumpFlags: (bool[]) Dump flags
	 *  - debugFlags: (bool[]) Debug flags
	 *  - nativeTemplateExpansion: boolean
	 *  - discardDataParsoid: boolean
	 *  - offsetType: 'byte' (default), 'ucs2', 'char'
	 *                See `Parsoid\Wt2Html\PP\Processors\ConvertOffsets`.
	 *  - logLinterData: (bool) Should we log linter data if linting is enabled?
	 *  - htmlVariantLanguage: string|null
	 *      If non-null, the language variant used for Parsoid HTML;
	 *      we convert to this if wt2html, or from this if html2wt.
	 *  - wtVariantLanguage: string|null
	 *      If non-null, the language variant to be used for wikitext.
	 *      If null, heuristics will be used to identify the original
	 *      wikitext variant in wt2html mode, and in html2wt mode new
	 *      or edited HTML will be left unconverted.
	 *  - logLevels: (string[]) Levels to log
	 *  - topLevelDoc: (Document) Set explicitly when serializing otherwise
	 *      it gets initialized for parsing.
	 */
	public function __construct(
		SiteConfig $siteConfig,
		PageConfig $pageConfig,
		DataAccess $dataAccess,
		ContentMetadataCollector $metadata,
		?array $options = null
	) {
		self::checkPlatform();
		$options = $options ?? [];
		$this->siteConfig = $siteConfig;
		$this->pageConfig = $pageConfig;
		$this->dataAccess = $dataAccess;
		$this->metadata = $metadata;
		$this->topFrame = new PageConfigFrame( $this, $pageConfig, $siteConfig );
		if ( isset( $options['wrapSections'] ) ) {
			$this->wrapSections = !empty( $options['wrapSections'] );
		}
		if ( isset( $options['pageBundle'] ) ) {
			$this->pageBundle = !empty( $options['pageBundle'] );
		}
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
		$this->htmlVariantLanguage = $options['htmlVariantLanguage'] ?? null;
		$this->wtVariantLanguage = $options['wtVariantLanguage'] ?? null;
		$this->nativeTemplateExpansion = !empty( $options['nativeTemplateExpansion'] );
		$this->discardDataParsoid = !empty( $options['discardDataParsoid'] );
		$this->requestOffsetType = $options['offsetType'] ?? 'byte';
		$this->logLinterData = !empty( $options['logLinterData'] );
		$this->traceFlags = $options['traceFlags'] ?? [];
		$this->dumpFlags = $options['dumpFlags'] ?? [];
		$this->debugFlags = $options['debugFlags'] ?? [];
		$this->parsoidLogger = new ParsoidLogger( $this->siteConfig->getLogger(), [
			'logLevels' => $options['logLevels'] ?? [ 'fatal', 'error', 'warn', 'info' ],
			'debugFlags' => $this->debugFlags,
			'dumpFlags' => $this->dumpFlags,
			'traceFlags' => $this->traceFlags
		] );
		if ( $this->hasTraceFlag( 'time' ) ) {
			$this->profiling = true;
		}
		$this->setupTopLevelDoc( $options['topLevelDoc'] ?? null );
		$this->wikitextContentModelHandler = new WikitextContentModelHandler( $this );
	}

	/**
	 * Check to see if the PHP platform is sensible
	 */
	private static function checkPlatform() {
		static $checked;
		if ( !$checked ) {
			$highBytes =
				"\x80\x81\x82\x83\x84\x85\x86\x87\x88\x89\x8a\x8b\x8c\x8d\x8e\x8f" .
				"\x90\x91\x92\x93\x94\x95\x96\x97\x98\x99\x9a\x9b\x9c\x9d\x9e\x9f" .
				"\xa0\xa1\xa2\xa3\xa4\xa5\xa6\xa7\xa8\xa9\xaa\xab\xac\xad\xae\xaf" .
				"\xb0\xb1\xb2\xb3\xb4\xb5\xb6\xb7\xb8\xb9\xba\xbb\xbc\xbd\xbe\xbf" .
				"\xc0\xc1\xc2\xc3\xc4\xc5\xc6\xc7\xc8\xc9\xca\xcb\xcc\xcd\xce\xcf" .
				"\xd0\xd1\xd2\xd3\xd4\xd5\xd6\xd7\xd8\xd9\xda\xdb\xdc\xdd\xde\xdf" .
				"\xe0\xe1\xe2\xe3\xe4\xe5\xe6\xe7\xe8\xe9\xea\xeb\xec\xed\xee\xef" .
				"\xf0\xf1\xf2\xf3\xf4\xf5\xf6\xf7\xf8\xf9\xfa\xfb\xfc\xfd\xfe\xff";
			if ( strtolower( 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' . $highBytes )
				!== 'abcdefghijklmnopqrstuvwxyz' . $highBytes
			) {
				throw new \RuntimeException( 'strtolower() doesn\'t work -- ' .
					'please set the locale to C or a UTF-8 variant such as C.UTF-8' );
			}
			$checked = true;
		}
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
		$profile = new Profile();
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

	/**
	 * @return bool
	 */
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

	/**
	 * @return bool
	 */
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
	 * @param string $str
	 */
	public function writeDump( string $str ) {
		error_log( $str );
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

	public function nativeTemplateExpansionEnabled(): bool {
		return $this->nativeTemplateExpansion;
	}

	/**
	 * Get the current uid counter value
	 * @return int
	 */
	public function getUID(): int {
		return $this->uid;
	}

	/**
	 * Get the current fragment id counter value
	 * @return int
	 */
	public function getFID(): int {
		return $this->fid;
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
	 * Return the external format of character offsets in source ranges.
	 * Internally we always keep DomSourceRange and SourceRange information
	 * as UTF-8 byte offsets for efficiency (matches the native string
	 * representation), but for external use we can convert these to
	 * other formats when we output wt2html or input for html2wt.
	 *
	 * @see Parsoid\Wt2Html\PP\Processors\ConvertOffsets
	 * @return string 'byte', 'ucs2', or 'char'
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
	 * @see Parsoid\Wt2Html\PP\Processors\ConvertOffsets
	 * @return string 'byte', 'ucs2', or 'char'
	 */
	public function getCurrentOffsetType(): string {
		return $this->currentOffsetType;
	}

	/**
	 * Update the current offset type. Only
	 * Parsoid\Wt2Html\PP\Processors\ConvertOffsets should be doing this.
	 * @param string $offsetType 'byte', 'ucs2', or 'char'
	 */
	public function setCurrentOffsetType( string $offsetType ) {
		$this->currentOffsetType = $offsetType;
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

		$pageConfig = $this->getPageConfig();

		// Resolve lonely fragments (important if the current page is a subpage,
		// otherwise the relative link will be wrong)
		if ( $str !== '' && $str[0] === '#' ) {
			$str = $pageConfig->getTitle() . $str;
		}

		// Default return value
		$titleKey = $str;
		if ( $this->getSiteConfig()->namespaceHasSubpages( $pageConfig->getNs() ) ) {
			// Resolve subpages
			$reNormalize = false;
			if ( preg_match( '!^(?:\.\./)+!', $str, $relUp ) ) {
				$levels = strlen( $relUp[0] ) / 3;  // Levels are indicated by '../'.
				$titleBits = explode( '/', $pageConfig->getTitle() );
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
				$str = $pageConfig->getTitle() . $str;
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
	 * Convert a Title to a string
	 * @param Title $title
	 * @param bool $ignoreFragment
	 * @return string
	 */
	private function titleToString( Title $title, bool $ignoreFragment = false ): string {
		$ret = $title->getPrefixedDBKey();
		if ( !$ignoreFragment ) {
			$fragment = $title->getFragment() ?? '';
			if ( $fragment !== '' ) {
				$ret .= '#' . $fragment;
			}
		}
		return $ret;
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
		return $this->titleToString( $title, $ignoreFragment );
	}

	/**
	 * Create a Title object
	 * @param string $text URL-decoded text
	 * @param int|TitleNamespace $defaultNs
	 * @param bool $noExceptions
	 * @return Title|null
	 */
	private function makeTitle( string $text, $defaultNs = 0, bool $noExceptions = false ): ?Title {
		try {
			if ( preg_match( '!^(?:[#/]|\.\./)!', $text ) ) {
				$defaultNs = $this->getPageConfig()->getNs();
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
	 * @param int|TitleNamespace $defaultNs
	 * @param bool $noExceptions
	 * @return Title|null
	 */
	public function makeTitleFromText(
		string $str, $defaultNs = 0, bool $noExceptions = false
	): ?Title {
		return $this->makeTitle( Utils::decodeURIComponent( $str ), $defaultNs, $noExceptions );
	}

	/**
	 * Create a Title object
	 * @see Title::newFromText in MediaWiki
	 * @param string $str URL-decoded text
	 * @param int|TitleNamespace $defaultNs
	 * @param bool $noExceptions
	 * @return Title|null
	 */
	public function makeTitleFromURLDecodedStr(
		string $str, $defaultNs = 0, bool $noExceptions = false
	): ?Title {
		return $this->makeTitle( $str, $defaultNs, $noExceptions );
	}

	/**
	 * Make a link to a Title
	 * @param Title $title
	 * @return string
	 */
	public function makeLink( Title $title ): string {
		return $this->getSiteConfig()->relativeLinkPrefix() . Sanitizer::sanitizeTitleURI(
			$this->titleToString( $title ),
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
	 * Generate a new uid
	 * @return int
	 */
	public function generateUID(): int {
		return $this->uid++;
	}

	/**
	 * Generate a new object id
	 * @return string
	 */
	public function newObjectId(): string {
		return "mwt" . $this->generateUID();
	}

	/**
	 * Generate a new annotation uid
	 * @return int
	 */
	public function generateAnnotationUID(): int {
		return $this->annUid++;
	}

	/**
	 * Generate a new annotation id
	 * @return string
	 */
	public function newAnnotationId(): string {
		return "mwa" . $this->generateAnnotationUID();
	}

	/**
	 * Generate a new about id
	 * @return string
	 */
	public function newAboutId(): string {
		return "#" . $this->newObjectId();
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
	 * Generate a new fragment id
	 * @return string
	 */
	public function newFragmentId(): string {
		return "mwf" . (string)$this->fid++;
	}

	/**
	 * When an environment is constructed, we initialize a document (and
	 * RemexPipeline) to be used throughout the parse.
	 *
	 * @param ?Document $topLevelDoc
	 */
	public function setupTopLevelDoc( ?Document $topLevelDoc = null ) {
		if ( $topLevelDoc ) {
			$this->topLevelDoc = $topLevelDoc;
		} else {
			$this->remexPipeline = new RemexPipeline( $this );
			$this->topLevelDoc = $this->remexPipeline->doc;
		}
		DOMDataUtils::prepareDoc( $this->topLevelDoc );
	}

	/**
	 * @param bool $atTopLevel
	 * @return RemexPipeline
	 */
	public function fetchRemexPipeline( bool $atTopLevel ): RemexPipeline {
		if ( $atTopLevel ) {
			return $this->remexPipeline;
		} else {
			$pipeline = new RemexPipeline( $this );
			// Attach the top-level bag to the document, for the convenience
			// of code that modifies the data within the RemexHtml TreeBuilder
			// pipeline, prior to the migration of nodes to the top-level
			// document.
			DOMDataUtils::prepareChildDoc( $this->topLevelDoc, $pipeline->doc );
			return $pipeline;
		}
	}

	/**
	 * BehaviorSwitchHandler support function that adds a property named by
	 * $variable and sets it to $state
	 *
	 * @deprecated Use setBehaviorSwitch() instead.
	 * @param string $variable
	 * @param mixed $state
	 */
	public function setVariable( string $variable, $state ): void {
		$this->setBehaviorSwitch( $variable, $state );
	}

	/**
	 * Record a behavior switch.
	 *
	 * @todo Does this belong here, or on some equivalent to MediaWiki's ParserOutput?
	 * @param string $switch Switch name
	 * @param mixed $state Relevant state data to record
	 */
	public function setBehaviorSwitch( string $switch, $state ): void {
		$this->behaviorSwitches[$switch] = $state;
	}

	/**
	 * Fetch the state of a previously-recorded behavior switch.
	 *
	 * @todo Does this belong here, or on some equivalent to MediaWiki's ParserOutput?
	 * @param string $switch Switch name
	 * @param mixed $default Default value if the switch was never set
	 * @return mixed State data that was previously passed to setBehaviorSwitch(), or $default
	 */
	public function getBehaviorSwitch( string $switch, $default = null ) {
		return $this->behaviorSwitches[$switch] ?? $default;
	}

	/**
	 * @return array<string,DocumentFragment>
	 */
	public function getDOMFragmentMap(): array {
		return $this->fragmentMap;
	}

	/**
	 * @param string $id Fragment id
	 * @return DocumentFragment
	 */
	public function getDOMFragment( string $id ): DocumentFragment {
		return $this->fragmentMap[$id];
	}

	/**
	 * @param string $id Fragment id
	 * @param DocumentFragment $forest DOM forest
	 *   to store against the fragment id
	 */
	public function setDOMFragment(
		string $id, DocumentFragment $forest
	): void {
		$this->fragmentMap[$id] = $forest;
	}

	/**
	 * @param string $id
	 */
	public function removeDOMFragment( string $id ): void {
		$domFragment = $this->fragmentMap[$id];
		Assert::invariant(
			!$domFragment->hasChildNodes(), 'Fragment should be empty.'
		);
		unset( $this->fragmentMap[$id] );
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
		// Parsoid-JS tests don't like getting null properties where JS had undefined.
		$lintData = array_filter( $lintData, static function ( $v ) {
			return $v !== null;
		} );

		if ( empty( $lintData['dsr'] ) ) {
			$this->log( 'error/lint', "Missing DSR; msg=", $lintData );
			return;
		}

		// This will always be recorded as a native 'byte' offset
		$lintData['dsr'] = $lintData['dsr']->jsonSerialize();

		// Ensure a "params" array
		if ( !isset( $lintData['params'] ) ) {
			$lintData['params'] = [];
		}

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
	 * @param mixed ...$args
	 */
	public function log( ...$args ): void {
		$this->parsoidLogger->log( ...$args );
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
		$contentmodel = $contentmodel ?? $this->pageConfig->getContentModel();
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
		return $this->siteConfig->langConverterEnabledForLanguage(
			$this->pageConfig->getPageLanguage()
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
	 * @return string|null
	 */
	public function getHtmlVariantLanguage(): ?string {
		return $this->htmlVariantLanguage;
	}

	/**
	 * If non-null, the language variant to be used for wikitext.  If null,
	 * heuristics will be used to identify the original wikitext variant
	 * in wt2html mode, and in html2wt mode new or edited HTML will be left
	 * unconverted.
	 *
	 * @return string|null
	 */
	public function getWtVariantLanguage(): ?string {
		return $this->wtVariantLanguage;
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
	 * @return string
	 */
	public function htmlContentLanguage(): string {
		// PageConfig::htmlVariant is set iff we do variant conversion on the
		// HTML
		return $this->pageConfig->getVariant() ??
			$this->pageConfig->getPageLanguage();
	}
}
