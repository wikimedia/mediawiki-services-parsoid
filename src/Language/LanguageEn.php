<?php

namespace Parsoid\Language;

/** English ( / Pig Latin) conversion code */
class LanguageEn extends Language {

	public function __construct() {
		$variants = [ 'en', 'en-x-piglatin' ];
		$this->setConverter( new EnConverter( $this, 'en', $variants ) );
	}

}
