<?php
declare( strict_types = 1 );

namespace Parsoid\Config;

use Closure;
use DOMDocument;
use DOMElement;
use DOMNode;
use Parsoid\ContentModelHandler;
use Parsoid\ResourceLimitExceededException;
use Parsoid\Tokens\Token;
use Parsoid\Utils\DataBag;
use Parsoid\Utils\DOMCompat;
use Parsoid\Utils\DOMUtils;
use Parsoid\Utils\PHPUtils;
use Parsoid\Utils\Title;
use Parsoid\Utils\TitleNamespace;
use Parsoid\Utils\TitleException;
use Parsoid\Utils\TokenUtils;
use Parsoid\Utils\Util;
use Parsoid\Wt2Html\Frame;
use Parsoid\Wt2Html\PageConfigFrame;
use Parsoid\Wt2Html\ParserPipelineFactory;
use Parsoid\Wt2Html\TT\Sanitizer;

// phpcs:disable MediaWiki.Commenting.FunctionComment.MissingDocumentationPublic

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
	 * @var bool Are we in offline mode?
	 * Offline mode is useful in two scenarios:
	 * (a) running scripts (wt2html, html2wt, etc.) in offline mode during development
	 *     and in isolation without any MediaWiki context.
	 * (b) running parser tests: parser tests should run in isolation without requiring
	 *     any MediaWiki context or making API requests.
	 */
	private $offlineMode;

	/** @phan-var array<string,int> */
	private $wt2htmlLimits = [];
	/** @phan-var array<string,int> */
	private $wt2htmlUsage = [];

	/** @phan-var array<string,int> */
	private $html2wtLimits = [];
	/** @phan-var array<string,int> */
	private $html2wtUsage = [];

	/** @var DOMDocument[] */
	private $liveDocs = [];

	/** @var bool */
	private $wrapSections = true;

	/** @var array<string,mixed> */
	private $behaviorSwitches = [];

	/**
	 * Maps fragment id to the fragment forest (array of DOMNodes).
	 * @var array<string,DOMNode[]>
	 */
	private $fragmentMap = [];

	/**
	 * @var int used to generate fragment ids as needed during parse
	 */
	private $fid = 1;

	/** @var int used to generate uids as needed during this parse */
	private $uid = 1;

	/** @var array[] Lints recorded */
	private $lints = [];

	/** @var bool[] */
	public $traceFlags;

	/** @var bool[] */
	public $dumpFlags;

	/** @var float */
	public $startTime;

	/** @var bool */
	private $scrubWikitext;

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

	/** @var DOMNode */
	private $origDOM;

	/** @var DOMDocument */
	private $domDiff;

	/**
	 * Page properties (module resources primarily) that need to be output
	 * @var array
	 */
	private $outputProps = [];

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
	 * @param SiteConfig $siteConfig
	 * @param PageConfig $pageConfig
	 * @param DataAccess $dataAccess
	 * @param array $options
	 *  - wrapSections: (bool) Whether `<section>` wrappers should be added.
	 *  - scrubWikitext: (bool) Indicates emit "clean" wikitext.
	 *  - traceFlags: (array) Flags indicating which components need to be traced
	 *  - dumpFlags: (bool[]) Dump flags
	 *  - uid: (int) Initial value of UID used to generate ids during parse.
	 *         defaults to 1.
	 *         PORT-FIXME: This construction option is required to support hybrid
	 *         testing and can be removed after porting and testing is complete.
	 *  - fid: (int) Initial value of fragment id used to generate ids during parse.
	 *         defaults to 1.
	 *         PORT-FIXME: This construction option is required to support hybrid
	 *         testing and can be removed after porting and testing is complete.
	 */
	public function __construct(
		SiteConfig $siteConfig, PageConfig $pageConfig, DataAccess $dataAccess, array $options = []
	) {
		$this->siteConfig = $siteConfig;
		$this->pageConfig = $pageConfig;
		$this->dataAccess = $dataAccess;
		$this->topFrame = new PageConfigFrame( $this, $pageConfig );
		$this->scrubWikitext = !empty( $options['scrubWikitext'] );
		$this->wrapSections = !empty( $options['wrapSections'] );
		$this->traceFlags = $options['traceFlags'] ?? [];
		$this->dumpFlags = $options['dumpFlags'] ?? [];
		$this->uid = (int)( $options['uid'] ?? 1 );
		$this->fid = (int)( $options['fid'] ?? 1 );
		$this->pipelineFactory = new ParserPipelineFactory( $this );
		$this->offlineMode = !empty( $options['offline'] );
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
	 * Are we running in offline mode?
	 * @return bool
	 */
	public function inOfflineMode(): bool {
		return $this->offlineMode;
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

	public function getPipelineFactory(): ParserPipelineFactory {
		return $this->pipelineFactory;
	}

	/**
	 * Resolve strings that are page-fragments or subpage references with
	 * respect to the current page name.
	 *
	 * TODO: Handle namespaces relative links like [[User:../../]] correctly, they
	 * shouldn't be treated like links at all.
	 *
	 * @param string $str Page fragment or subpage reference. Not URL encoded.
	 * @param bool $resolveOnly If true, only trim and add the current title to
	 *  lone fragments. TODO: This parameter seems poorly named.
	 * @return string Resolved title
	 */
	public function resolveTitle( string $str, bool $resolveOnly = false ): string {
		$origName = $str;
		$str = trim( $str ); // PORT-FIXME: Care about non-ASCII whitespace?

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
	 * Normalize and resolve the page title
	 * @deprecated Just use $this->getPageConfig()->getTitle() directly
	 * @return string
	 */
	public function normalizeAndResolvePageTitle() {
		return $this->getPageConfig()->getTitle();
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
		return $this->makeTitle( Util::decodeURIComponent( $str ), $defaultNs, $noExceptions );
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
		return Sanitizer::sanitizeTitleURI(
			$this->getSiteConfig()->relativeLinkPrefix() . $this->titleToString( $title ),
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
		$hrefToken = Util::decodeURIComponent( $href );
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
	 * Generate a new about id
	 * @return string
	 */
	public function newAboutId(): string {
		return "#" . $this->newObjectId();
	}

	/**
	 * Store reference to original DOM
	 * @param DOMElement $dom
	 */
	public function setOrigDOM( DOMElement $dom ): void {
		$this->origDOM = $dom;
	}

	/**
	 * Return reference to original DOM
	 * @return DOMElement
	 */
	public function getOrigDOM(): DOMElement {
		return $this->origDOM;
	}

	/**
	 * Store reference to DOM diff document
	 * @param DOMDocument $doc
	 */
	public function setDOMDiff( $doc ): void {
		$this->domDiff = $doc;
	}

	/**
	 * Return reference to DOM diff document
	 * @return DOMDocument|null
	 */
	public function getDOMDiff(): ?DOMDocument {
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
	 * FIXME: This function could be given a better name to reflect what it does.
	 *
	 * @param DOMDocument $doc
	 * @param DataBag|null $bag
	 */
	public function referenceDataObject( DOMDocument $doc, ?DataBag $bag = null ): void {
		// `bag` is a deliberate dynamic property; see DOMDataUtils::getBag()
		// @phan-suppress-next-line PhanUndeclaredProperty dynamic property
		$doc->bag = $bag ?? new DataBag();

		// Prevent GC from collecting the PHP wrapper around the libxml doc
		$this->liveDocs[] = $doc;
	}

	/**
	 * @param string $html
	 * @return DOMDocument
	 */
	public function createDocument( string $html = '' ): DOMDocument {
		$doc = DOMUtils::parseHTML( $html );
		// Cache the head and body.
		DOMCompat::getHead( $doc );
		DOMCompat::getBody( $doc );
		$this->referenceDataObject( $doc );
		return $doc;
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
	 * @param mixed|null $default Default value if the switch was never set
	 * @return mixed State data that was previously passed to setBehaviorSwitch(), or $default
	 */
	public function getBehaviorSwitch( string $switch, $default = null ) {
		return $this->behaviorSwitches[$switch] ?? $default;
	}

	/**
	 * FIXME: Once we remove the hardcoded slot name here,
	 * the name of this method could be updated, if necessary.
	 *
	 * Shortcut method to get page source
	 * @deprecated Use $this->topFrame->getSrcText()
	 * @return string
	 */
	public function getPageMainContent(): string {
		return $this->pageConfig->getRevisionContent()->getContent( 'main' );
	}

	/**
	 * @return array<string,DOMNode[]>
	 */
	public function getFragmentMap(): array {
		return $this->fragmentMap;
	}

	/**
	 * @param string $id Fragment id
	 * @return DOMNode[]
	 */
	public function getFragment( string $id ): array {
		return $this->fragmentMap[$id];
	}

	/**
	 * @param string $id Fragment id
	 * @param DOMNode[] $forest DOM forest (contiguous array of DOM trees)
	 *   to store against the fragment id
	 */
	public function setFragment( string $id, array $forest ): void {
		$this->fragmentMap[$id] = $forest;
	}

	/**
	 * Record a lint
	 * @param string $type Lint type key
	 * @param array $lintData Data for the lint.
	 */
	public function recordLint( string $type, array $lintData ): void {
		// Parsoid-JS tests don't like getting null properties where JS had undefined.
		$lintData = array_filter( $lintData, function ( $v ) {
			return $v !== null;
		} );

		$this->log( "lint/$type", $lintData );
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
	 * Deprecated logging function.
	 * @deprecated Use $this->getSiteConfig()->getLogger() instead.
	 * @param string $prefix
	 * @param mixed ...$args
	 */
	public function log( string $prefix, ...$args ): void {
		$logger = $this->getSiteConfig()->getLogger();
		if ( $logger instanceof \Psr\Log\NullLogger ) {
			// No need to build the string if it's going to be thrown away anyway.
			return;
		}

		$output = $prefix;
		$numArgs = count( $args );
		for ( $index = 0; $index < $numArgs; $index++ ) {
			// don't use is_callable, it would return true for any string that happens to be a function name
			if ( $args[$index] instanceof Closure ) {
				$output = $output . ' ' . $args[$index]();
			} elseif ( is_array( $args[$index] ) ) {
				$output = $output . '[';
				$elements = count( $args[$index] );
				for ( $i = 0; $i < $elements; $i++ ) {
					if ( $i > 0 ) {
						$output = $output . ',';
					}
					if ( is_string( $args[$index][$i] ) ) {
						$output = $output . '"' . $args[$index][$i] . '"';
					} else {
						// PORT_FIXME the JS output is '[Object object] but we output the actual token class
						$output = $output . PHPUtils::jsonEncode( $args[$index][$i] );
					}
				}
				$output = $output . ']';
			} else {
				if ( is_string( $args[$index] ) ) {
					$output = $output . ' ' . $args[$index];
				} else {
					$output = $output . PHPUtils::jsonEncode( $args[$index] );
				}
			}
		}
		$logger->debug( $output );
	}

	/**
	 * Update a profile timer.
	 *
	 * @param string $resource
	 * @param mixed $time
	 * @param mixed $cat
	 */
	public function bumpTimeUse( string $resource, $time, $cat ): void {
		throw new \BadMethodCallException( 'not yet ported' );
	}

	/**
	 * Update a profile counter.
	 *
	 * @param string $resource
	 * @param int $n The amount to increment the counter; defaults to 1.
	 */
	public function bumpCount( string $resource, int $n = 1 ): void {
		throw new \BadMethodCallException( 'not yet ported' );
	}

	/**
	 * Bump usage of some limited parser resource
	 * (ex: tokens, # transclusions, # list items, etc.)
	 *
	 * @param string $resource
	 * @param int $count How much of the resource is used?
	 * @throws ResourceLimitExceededException
	 */
	public function bumpWt2HtmlResourceUse( string $resource, int $count = 1 ): void {
		$n = $this->wt2htmlUsage[$resource] ?? 0;
		$n += $count;
		$this->wt2htmlUsage[$resource] = $n;
		if (
			isset( $this->wt2htmlLimits[$resource] ) &&
			$n > $this->wt2htmlLimits[$resource]
		) {
			// TODO: re-evaluate whether throwing an exception is really
			// the right failure strategy when Parsoid is integrated into MW
			// (T221238)
			throw new ResourceLimitExceededException( "wt2html: $resource limit exceeded: $n" );
		}
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
		if (
			isset( $this->html2wtLimits[$resource] ) &&
			$n > $this->html2wtLimits[$resource]
		) {
			throw new ResourceLimitExceededException( "html2wt: $resource limit exceeded: $n" );
		}
	}

	/**
	 * Get an appropriate content handler, given a contentmodel.
	 *
	 * @param string|null $forceContentModel An optional content model which
	 *   will override whatever the source specifies.
	 * @return ContentModelHandler An appropriate content handler
	 */
	public function getContentHandler(
		?string $forceContentModel = null
	): ContentModelHandler {
		$contentmodel = $forceContentModel ?? $this->pageConfig->getContentModel();
		$handler = $this->siteConfig->getContentModelHandler( $contentmodel );
		if ( !$handler ) {
			$this->log( 'warn', "Unknown contentmodel $contentmodel" );
			$handler = $this->siteConfig->getContentModelHandler( 'wikitext' );
		}
		return $handler;
	}

	/**
	 * Is the language converter enabled on this page?
	 * @return bool
	 */
	public function langConverterEnabled(): bool {
		$lang = $this->pageConfig->getPageLanguage();
		if ( !$lang ) {
			$lang = $this->siteConfig->lang();
		}
		if ( !$lang ) {
			$lang = 'en';
		}
		return $this->siteConfig->langConverterEnabled( $lang );
	}

	/**
	 * Indicates emit "clean" wikitext compared to what we would if we didn't normalize HTML
	 * @return bool
	 */
	public function shouldScrubWikitext(): bool {
		return $this->scrubWikitext;
	}

	/**
	 * The HTML content version of the input document (for html2wt and html2html conversions).
	 * @see https://www.mediawiki.org/wiki/Parsoid/API#Content_Negotiation
	 * @see https://www.mediawiki.org/wiki/Specs/HTML/2.1.0#Versioning
	 * @return string A semver version number
	 */
	public function getInputContentVersion(): string {
		// PORT-FIXME implement this. See MWParserEnvironment.availableVersions,
		// DOMUtils::extractInlinedContentVersion(), apiUtils.versionFromType, routes.js
		return '2.1.0';
	}

	/**
	 * Set a K=V property that might need to be output as part of the generated HTML
	 * Ex: module styles, modules scripts
	 *
	 * @param string $key
	 * @param mixed $value
	 */
	public function setOutputProperty( string $key, $value ): void {
		$this->outputProps[$key] = $value;
	}

	/**
	 * @return array
	 */
	public function getOutputProperties(): array {
		return $this->outputProps;
	}
}
