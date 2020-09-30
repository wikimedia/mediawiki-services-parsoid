<?php
declare( strict_types = 1 );

namespace Wikimedia\Parsoid\Wt2Html\PP\Processors;

use DOMNode;
use Wikimedia\Assert\Assert;
use Wikimedia\Parsoid\Config\Env;
use Wikimedia\Parsoid\Language\LanguageConverter;
use Wikimedia\Parsoid\Wt2Html\Wt2HtmlDOMProcessor;

class LangConverter implements Wt2HtmlDOMProcessor {
	/**
	 * @inheritDoc
	 */
	public function run(
		Env $env, DOMNode $root, array $options = [], bool $atTopLevel = false
	): void {
		Assert::invariant( $atTopLevel, 'This pass should only be run on the top-level' );
		LanguageConverter::maybeConvert(
			$env,
			$root->ownerDocument,
			$env->getHtmlVariantLanguage(),
			$env->getWtVariantLanguage()
		);
	}
}
