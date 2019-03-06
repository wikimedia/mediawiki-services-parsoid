<?php
declare( strict_types = 1 );

namespace Parsoid\Config;

use DOMDocument;
use DOMNode;
use Parsoid\Utils\DOMUtils;
use Parsoid\Utils\DOMDataUtils;
use Parsoid\Utils\DataBag;

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

	/** @var array */
	private $behaviorSwitches = [];

	/** @var array Maps fragment id to the fragment forest (array of DOMNodes)  */
	private $fragmentMap = [];

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
	 * FIXME: This function could be given a better name to reflect what it does.
	 *
	 * @param DOMDocument $doc
	 * @param DataBag|null $bag
	 */
	public function referenceDataObject( DOMDocument $doc, ?DataBag $bag = null ) {
		DOMDataUtils::setDocBag( $doc, $bag );

		// Prevent GC from collecting the PHP wrapper around the libxml doc
		$this->liveDocs[] = $doc;
	}

	/**
	 * @param string $html
	 * @return DOMDocument
	 */
	public function createDocument( string $html ): DOMDocument {
		$doc = DOMUtils::parseHTML( $html );
		// PORT-FIXME: Use DOMCompat utility once that lands
		$doc->head = $doc->getElementsByTagName( 'head' )->item( 0 );
		$doc->body = $doc->getElementsByTagName( 'body' )->item( 0 );
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
	 * @return array
	 */
	public function getFragmentMap(): array {
		return $this->fragmentMap;
	}

	/**
	 * @param string $id Fragment id
	 * @return DOMNode[]
	 */
	public function getFragment( string $id ) {
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

}
