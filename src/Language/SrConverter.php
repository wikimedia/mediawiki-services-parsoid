<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Language;

use Wikimedia\LangConv\FstReplacementMachine;

class SrConverter extends LanguageConverter {

	public function loadDefaultTables() {
		$this->setMachine( new FstReplacementMachine( 'sr', [ 'sr-ec', 'sr-el' ] ) );
	}

	// phpcs:ignore MediaWiki.Commenting.FunctionComment.MissingDocumentationPublic
	public function findVariantLink( $link, $nt, $ignoreOtherCond ) {
		$ns = $nt->getNamespace();
		// do not try to find variants for usernames
		if ( $ns->isUser() || $ns->isUserTalk ) {
			return [ 'nt' => $nt, 'link' => $link ];
		}
		// FIXME check whether selected language is 'sr'
		return parent::findVariantLink( $link, $nt, $ignoreOtherCond );
	}

	/**
	 * Variant based on the ReplacementMachine's bracketing abilities
	 * @param string $text
	 * @param string $variant
	 * @return bool
	 */
	public function guessVariant( $text, $variant ) {
		$r = [];
		$machine = $this->getMachine();
		'@phan-var FstReplacementMachine $machine'; /* @var FstReplacementMachine $machine */
		foreach ( $machine->getCodes() as $code => $ignore1 ) {
			foreach ( $machine->getCodes() as $othercode => $ignore2 ) {
				if ( $code === $othercode ) {
					return false;
				}
				$r[] = [
					'code' => $code,
					'othercode' => $othercode,
					'stats' => $machine->countBrackets( $text, $code, $othercode )
				];
			}
		}
		uasort( $r, static function ( $a, $b ) {
			return $a['stats']->unsafe - $b['stats']->unsafe;
		} );
		return $r[0]['othercode'] === $variant;
	}
}
