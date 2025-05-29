<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Language;

use Wikimedia\LangConv\FstReplacementMachine;

class KuConverter extends LanguageConverter {

	public function loadDefaultTables(): void {
		$this->setMachine( new FstReplacementMachine( 'ku', [ 'ku-arab', 'ku-latn' ] ) );
	}

	/** @inheritDoc */
	public function findVariantLink( $link, $nt, $ignoreOtherCond ): array {
		$ns = $nt->getNamespace();
		// do not try to find variants for usernames
		if ( $ns->isUser() || $ns->isUserTalk ) {
			return [ 'nt' => $nt, 'link' => $link ];
		}
		// FIXME check whether selected language is 'ku'
		return parent::findVariantLink( $link, $nt, $ignoreOtherCond );
	}
}
