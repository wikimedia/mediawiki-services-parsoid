<?php
declare( strict_types = 1 );

namespace Parsoid\Wt2Html\PP\Processors;

use DOMElement;
use Parsoid\Config\Env;

class LangConverter {
	/**
	 * @param DOMElement $rootNode
	 * @param Env $env
	 * @param array|null $options
	 */
	public function run( DOMElement $rootNode, Env $env, $options = [] ) {
		// LanguageConverter::maybeConvert(
		// 	$env, $rootNode->ownerDocument,
		// 	$env->htmlVariantLanguage, $env->wtVariantLanguage
		// );
	}
}
