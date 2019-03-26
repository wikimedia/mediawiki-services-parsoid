<?php
declare( strict_types = 1 );

namespace Parsoid\Config;

use DOMDocument;
use DOMNode;
use Parsoid\Utils\DataBag;
use Parsoid\Utils\DOMCompat;
use Parsoid\Utils\DOMUtils;

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

	/** @var int used to generate uids as needed during this parse */
	private $uid = 1;

	/** @var bool[] */
	public $traceFlags;

	/**
	 * @param SiteConfig $siteConfig
	 * @param PageConfig $pageConfig
	 * @param DataAccess $dataAccess
	 * @param array $options
	 *  - wrapSections: (bool) Whether `<section>` wrappers should be added.
	 */
	public function __construct(
		SiteConfig $siteConfig, PageConfig $pageConfig, DataAccess $dataAccess, array $options = []
	) {
		$this->siteConfig = $siteConfig;
		$this->pageConfig = $pageConfig;
		$this->dataAccess = $dataAccess;
		$this->wrapSections = !empty( $options['wrapSections'] );
		$this->traceFlags = $options['traceFlags'] ?? [];
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
	 * Whether `<section>` wrappers should be added.
	 * @todo Does this actually belong here? Should it be a behavior switch?
	 * @return bool
	 */
	public function getWrapSections(): bool {
		return $this->wrapSections;
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
	 * FIXME: This function could be given a better name to reflect what it does.
	 *
	 * @param DOMDocument $doc
	 * @param DataBag|null $bag
	 */
	public function referenceDataObject( DOMDocument $doc, ?DataBag $bag = null ): void {
		$doc->bag = $bag ?? new DataBag();

		// Prevent GC from collecting the PHP wrapper around the libxml doc
		$this->liveDocs[] = $doc;
	}

	/**
	 * @param string $html
	 * @return DOMDocument
	 */
	public function createDocument( string $html ): DOMDocument {
		$doc = DOMUtils::parseHTML( $html );
		$doc->head = DOMCompat::getHead( $doc );
		$doc->body = DOMCompat::getBody( $doc );
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
			if ( is_callable( $args[$index] ) ) {
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
						$output = $output . json_encode( $args[$index][$i] );
					}
				}
				$output = $output . ']';
			} else {
				$output = $output . ' ' . $args[$index];
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
	 */
	public function bumpParserResourceUse( string $resource, int $count = 1 ): void {
		throw new \BadMethodCallException( 'not yet ported' );
	}

	/**
	 * Is the language converted enabled on this page?
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
}
