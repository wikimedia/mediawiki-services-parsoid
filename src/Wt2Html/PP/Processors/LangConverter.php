<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\PP\Processors;

use DOMElement;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Language\LanguageConverter;

class LangConverter {

	/**
	 * @param DOMElement $rootNode
	 * @param Env $env
	 * @param array|null $options
	 */
	public function run( DOMElement $rootNode, Env $env, $options = [] ) {
		LanguageConverter::maybeConvert(
			$env,
			$rootNode->ownerDocument,
			$env->getHtmlVariantLanguage(),
			$env->getWtVariantLanguage()
		);
	}

}
