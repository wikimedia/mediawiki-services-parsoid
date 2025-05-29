<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Language;

use Wikimedia\LangConv\FstReplacementMachine;

class EnConverter extends LanguageConverter {

	public function loadDefaultTables(): void {
		$this->setMachine( new FstReplacementMachine( 'en', [ 'en', 'en-x-piglatin' ] ) );
	}

	/** @inheritDoc */
	public function findVariantLink( $link, $nt, $ignoreOtherCond ): array {
		$ns = $nt->getNamespace();
		// do not try to find variants for usernames
		if ( $ns->isUser() || $ns->isUserTalk ) {
			return [ 'nt' => $nt, 'link' => $link ];
		}
		// FIXME check whether selected language is 'en'
		return parent::findVariantLink( $link, $nt, $ignoreOtherCond );
	}
}
