<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * Crimean Tatar (Qırımtatarca) conversion code.
 * @module
 */

namespace Parsoid;

use Parsoid\Language as Language;
use Parsoid\LanguageConverter as LanguageConverter;
use Parsoid\ReplacementMachine as ReplacementMachine;

class CrhConverter extends LanguageConverter {
	public function loadDefaultTables() {
		$this->mTables = new ReplacementMachine( 'crh', 'crh-latn', 'crh-cyrl' );
	}
	// do not try to find variants for usernames
	public function findVariantLink( $link, $nt, $ignoreOtherCond ) {
		$ns = $nt->getNamespace();
		if ( $ns->isUser() || $ns->isUserTalk ) {
			return [ 'nt' => $nt, 'link' => $link ];
		}
		// FIXME check whether selected language is 'crh'
		return parent::findVariantLink( $link, $nt, $ignoreOtherCond );
	}
}

class LanguageCrh extends Language {
	public function __construct() {
		parent::__construct();
		$variants = [ 'crh', 'crh-cyrl', 'crh-latn' ];
		$variantfallbacks = new Map( [
				[ 'crh', 'crh-latn' ],
				[ 'crh-cyrl', 'crh-latn' ],
				[ 'crh-latn', 'crh-cyrl' ]
			]
		);
		$this->mConverter = new CrhConverter(
			$this, 'crh', $variants, $variantfallbacks
		);
	}
	public $mConverter;

}

$module->exports = $LanguageCrh;
