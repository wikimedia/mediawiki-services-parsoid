<?php

namespace Wikimedia\Parsoid\Language;

use Wikimedia\Parsoid\DOM\Element;

/**
 * An oracle that gives you a predicted "source language" for every node in a DOM, which is used
 * when converting the result back to the source language during round-tripping.
 */
abstract class LanguageGuesser {

	/**
	 * @param Element $node
	 * @return string predicted source language
	 */
	abstract public function guessLang( Element $node ): string;

}
