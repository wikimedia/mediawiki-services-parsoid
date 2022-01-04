<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Language;

use Wikimedia\Parsoid\DOM\Element;

/**
 * A simple {@link LanguageGuesser} that returns the same "source language" for every node.
 * Appropriate for wikis which by convention are written in a single variant.
 */
class ConstantLanguageGuesser extends LanguageGuesser {

	/** @var string */
	private $langCode;

	/**
	 * @param string $langCode
	 */
	public function __construct( string $langCode ) {
		$this->langCode = $langCode;
	}

	/** @inheritDoc */
	public function guessLang( Element $node ): string {
		return $this->langCode;
	}

}
