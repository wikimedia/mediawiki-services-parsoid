<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Language;

use Wikimedia\LangConv\ZhReplacementMachine;

/* @note: Use of this class is currently disabled in production, see T346657 */
class ZhConverter extends LanguageConverter {

	public function loadDefaultTables(): void {
		$this->setMachine( new ZhReplacementMachine() );
	}

	/** @inheritDoc */
	public function findVariantLink( $link, $nt, $ignoreOtherCond ): array {
		$ns = $nt->getNamespace();
		// do not try to find variants for usernames
		if ( $ns->isUser() || $ns->isUserTalk ) {
			return [ 'nt' => $nt, 'link' => $link ];
		}
		// FIXME check whether selected language is 'zh'
		return parent::findVariantLink( $link, $nt, $ignoreOtherCond );
	}
}
