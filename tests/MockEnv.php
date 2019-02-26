<?php

// This is copied over from the php-prototype branch where it was used during prototyping.
// This is an extremely partially constructed mock env object to aid testing.
// This will need much more solid mocking if it is to be used more extensively
// for standalone testing of the Parsoid/PHP composer library.

namespace Parsoid\Tests;

use DOMDocument;
use Parsoid\Utils\DOMUtils;
use Parsoid\Utils\DOMDataUtils;
use Parsoid\Utils\DataBag;

class MockEnv {
	/**
	 * Construct a mock environment object for use in tests
	 * @param array $opts
	 * @param string|null $pageSrc Wikitext source for the current title
	 */
	public function __construct( array $opts, $pageSrc = "Some dummy source wikitext for testing." ) {
		$this->logFlag = $opts['log'] ?? false;
		$this->wrapSections = $opts['wrapSections'] ?? false;
		$this->page = new \stdClass();
		$this->page->src = $pageSrc;
		$this->conf = new \stdClass();
		$this->conf->parsoid = new \stdClass();
		$this->conf->parsoid->rtTestMode = $opts['rtTestMode'] ?? false;
		$this->conf->wiki = new \stdClass();
		// Hack in bswPagePropRegexp to support Util.js function "isBehaviorSwitch: function(... "
		$this->conf->wiki->bswPagePropRegexp =
			'/(?:^|\\s)mw:PageProp\/(?:' .
				'NOGLOBAL|DISAMBIG|NOCOLLABORATIONHUBTOC|nocollaborationhubtoc|NOTOC|notoc|' .
				'NOGALLERY|nogallery|FORCETOC|forcetoc|TOC|toc|NOEDITSECTION|noeditsection|' .
				'NOTITLECONVERT|notitleconvert|NOTC|notc|NOCONTENTCONVERT|nocontentconvert|' .
				'NOCC|nocc|NEWSECTIONLINK|NONEWSECTIONLINK|HIDDENCAT|INDEX|NOINDEX|STATICREDIRECT' .
			')(?=$|\\s)/';
		// Mock function for BehaviorSwitchHandler
		// $this->conf->wiki->magicWordCanonicalName = 'magicWordCanonicalName';
		$this->conf->wiki->magicWordCanonicalName = function ( $param ) {
			return "toc";
		};
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
		$this->referenceDataObject( $doc );
		return $doc;
	}

	/**
	 * BehaviorSwitchHandler support function that adds a property named by
	 * $variable and sets it to $state
	 *
	 * @param string $variable
	 * @param mixed $state
	 */
	public function setVariable( string $variable, $state ) {
		$this->{ $variable } = $state;
	}

	/**
	 * Output log after computing any (lazy) arguments passed as function args
	 * @param string $prefix
	 * @param mixed ...$args
	 */
	public function log( $prefix, ...$args ) {
		$output = $prefix;
		if ( $this->logFlag ) {
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
			fwrite( STDERR, $output . "\n" );
		}
	}
}
