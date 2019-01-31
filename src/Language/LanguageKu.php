<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * Kurdish conversion code.
 * @module
 */

namespace Parsoid;

use Parsoid\Language as Language;
use Parsoid\LanguageConverter as LanguageConverter;
use Parsoid\ReplacementMachine as ReplacementMachine;

class KuConverter extends LanguageConverter {
	public function loadDefaultTables() {
		$this->mTables = new ReplacementMachine( 'ku', 'ku-arab', 'ku-latn' );
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

class LanguageKu extends Language {
	public function __construct() {
		parent::__construct();
		$variants = [ 'ku', 'ku-arab', 'ku-latn' ];
		$variantfallbacks = new Map( [
				[ 'ku', 'ku-latn' ],
				[ 'ku-arab', 'ku-latn' ],
				[ 'ku-latn', 'ku-arab' ]
			]
		);
		$this->mConverter = new KuConverter(
			$this, 'ku', $variants, $variantfallbacks
		);
	}
	public $mConverter;

}

$module->exports = $LanguageKu;
