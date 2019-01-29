<?php

// This is copied over from the php-prototype branch where it was used during prototyping.
// This is an extremely partially constructed mock env object to aid testing.
// This will need much more solid mocking if it is to be used more extensively
// for standalone testing of the Parsoid/PHP composer library.

namespace Parsoid\tests;

class MockEnv {
	/**
	 * Construct a mock environment object for use in tests
	 * @param array $opts
	 * @param string $pageSrc Wikitext source for the current title
	 */
	public function __construct( $opts, $pageSrc = "Some dummy source wikitext for testing." ) {
		$this->logFlag = isset( $opts->log );
		$this->wrapSections = true; // Always add <section> wrappers
		$this->page = (object)[ "src" => $pageSrc ];
		$this->conf = (object)[ "parsoid" => (object)[ "rtTestMode" => false ] ];
		$this->conf->wiki = [
			// Hack in bswPagePropRegexp to support Util.js function "isBehaviorSwitch: function(... "
			"bswPagePropRegexp" =>
				'/(?:^|\\s)mw:PageProp\/(?:' .
					'NOGLOBAL|DISAMBIG|NOCOLLABORATIONHUBTOC|nocollaborationhubtoc|NOTOC|notoc|' .
					'NOGALLERY|nogallery|FORCETOC|forcetoc|TOC|toc|NOEDITSECTION|noeditsection|' .
					'NOTITLECONVERT|notitleconvert|NOTC|notc|NOCONTENTCONVERT|nocontentconvert|' .
					'NOCC|nocc|NEWSECTIONLINK|NONEWSECTIONLINK|HIDDENCAT|INDEX|NOINDEX|STATICREDIRECT' .
				')(?=$|\\s)/',
			// Mock function for BehaviorSwitchHandler
			"magicWordCanonicalName" => function () {
				return "toc";
			}
		];
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
				} else {
					$output = $output . ' ' . $args[$index];
				}
			}
			echo $output . "\n";
		}
	}
}
