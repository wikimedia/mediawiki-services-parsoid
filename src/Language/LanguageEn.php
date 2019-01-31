<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * English ( / Pig Latin) conversion code.
 * @module
 */

namespace Parsoid;

use Parsoid\Language as Language;
use Parsoid\LanguageConverter as LanguageConverter;
use Parsoid\ReplacementMachine as ReplacementMachine;

class EnConverter extends LanguageConverter {
	public function loadDefaultTables() {
		$this->mTables = new ReplacementMachine( 'en', 'en', 'en-x-piglatin' );
	}
	// do not try to find variants for usernames
	public function findVariantLink( $link, $nt, $ignoreOtherCond ) {
		$ns = $nt->getNamespace();
		if ( $ns->isUser() || $ns->isUserTalk ) {
			return [ 'nt' => $nt, 'link' => $link ];
		}
		// FIXME check whether selected language is 'sr'
		return parent::findVariantLink( $link, $nt, $ignoreOtherCond );
	}
}

class LanguageEn extends Language {
	public function __construct() {
		parent::__construct();
		$variants = [ 'en', 'en-x-piglatin' ];
		$this->mConverter = new EnConverter(
			$this, 'en', $variants
		);
	}
	public $mConverter;

}

$module->exports = $LanguageEn;
