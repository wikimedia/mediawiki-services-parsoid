<?php

namespace Parsoid\Config;

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

	/** @var bool */
	private $wrapSections = true;

	/**
	 * @param SiteConfig $siteConfig
	 * @param PageConfig $pageConfig
	 * @param array $options
	 *  - wrapSections: (bool) Whether `<section>` wrappers should be added.
	 */
	public function __construct(
		SiteConfig $siteConfig, PageConfig $pageConfig, array $options = []
	) {
		$this->siteConfig = $siteConfig;
		$this->pageConfig = $pageConfig;
		$this->wrapSections = !empty( $options['wrapSections'] );
	}

	/**
	 * Get the site config
	 * @return SiteConfig
	 */
	public function getSiteConfig() : SiteConfig {
		return $this->siteConfig;
	}

	/**
	 * Get the page config
	 * @return PageConfig
	 */
	public function getPageConfig() : PageConfig {
		return $this->pageConfig;
	}

	/**
	 * Whether `<section>` wrappers should be added.
	 * @todo Does this actually belong here?
	 * @return bool
	 */
	public function getWrapSections() : bool {
		return $this->wrapSections;
	}

	/**
	 * Deprecated logging function.
	 * @deprecated Use $this->getSiteConfig()->getLogger() instead.
	 * @param string $prefix
	 * @param mixed ...$args
	 */
	public function log( string $prefix, ...$args ) {
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
