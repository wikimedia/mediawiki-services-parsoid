<?php
// phpcs:ignoreFile
// phpcs:disable Generic.Files.LineLength.TooLong
/* REMOVE THIS COMMENT AFTER PORTING */
/**
 * Serbian (Српски / Srpski) specific code.
 * @module
 */

namespace Parsoid;

use Parsoid\Language as Language;
use Parsoid\LanguageConverter as LanguageConverter;
use Parsoid\ReplacementMachine as ReplacementMachine;

class SrConverter extends LanguageConverter {
	public function loadDefaultTables() {
		$this->mTables = new ReplacementMachine( 'sr', 'sr-ec', 'sr-el' );
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

	/**
	 * Guess if a text is written in Cyrillic or Latin.
	 * Overrides LanguageConverter::guessVariant()
	 */
	public function guessVariant( $text, $variant ) {
		return $this->guessVariantParsoid( $text, $variant );
	}

	// Variant based on the ReplacementMachine's bracketing abilities
	public function guessVariantParsoid( $text, $variant ) {
		$r = [];
		foreach ( $this->mTables->codes as $code => $___ ) {
			foreach ( $this->mTables->codes as $othercode => $___ ) {
				if ( $code === $othercode ) { return;
	   }
				$r[] = [
					'code' => $code,
					'othercode' => $othercode,
					'stats' => $this->mTables->countBrackets( $text, $code, $othercode )
				];
			}
		}
		$r->sort( function ( $a, $b ) {return $a->stats->unsafe - $b->stats->unsafe;
  } );
		return $r[ 0 ]->othercode === $variant;
	}

	// Faithful translation of PHP heuristic
	public function guessVariantPHP( $text, $variant ) {
		// XXX: Should use the `u` regexp flag, in Node 6
		// but for these particular regexps it's actually not needed.
		// http://node.green/#ES2015-syntax-RegExp--y--and--u--flags--u--flag
		$numCyrillic = count( preg_match_all( "/[шђчћжШЂЧЋЖ]/", $text, $FIXME ) );
		$numLatin = count( preg_match_all( "/[šđčćžŠĐČĆŽ]/", $text, $FIXME ) );
		if ( $variant === 'sr-ec' ) {
			return $numCyrillic > $numLatin;
		} elseif ( $variant === 'sr-el' ) {
			return $numLatin > $numCyrillic;
		} else {
			return false;
		}
	}
}

class LanguageSr extends Language {
	public function __construct() {
		parent::__construct();
		$variants = [ 'sr', 'sr-ec', 'sr-el' ];
		$variantfallbacks = new Map( [
				[ 'sr', 'sr-ec' ],
				[ 'sr-ec', 'sr' ],
				[ 'sr-el', 'sr' ]
			]
		);
		$flags = new Map( [
				[ 'S', 'S' ], [ "писмо", 'S' ], [ 'pismo', 'S' ],
				[ 'W', 'W' ], [ "реч", 'W' ], [ "reč", 'W' ], [ "ријеч", 'W' ],
				[ "riječ", 'W' ]
			]
		);
		$this->mConverter = new SrConverter(
			$this, 'sr', $variants, $variantfallbacks, $flags
		);
	}
	public $mConverter;

}

$module->exports = $LanguageSr;
