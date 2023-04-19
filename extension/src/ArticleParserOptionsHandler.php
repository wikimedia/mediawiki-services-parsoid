<?php

namespace MWParsoid;

use Article;
use MediaWiki\Page\Hook\ArticleParserOptionsHook;
use ParserOptions;

class ArticleParserOptionsHandler implements ArticleParserOptionsHook {
	/**
	 * @see https://www.mediawiki.org/wiki/Manual:Hooks/ArticleParserOptions
	 * @param Article $article
	 * @param ParserOptions $popts
	 * @return bool|void
	 */
	public function onArticleParserOptions(
		Article $article, ParserOptions $popts
	) {
		// T335157: Enable Parsoid Read Views for articles as an experimental
		// feature; this is primarily used for internal testing at this time.
		$request = $article->getContext()->getRequest();
		$queryEnable = $request->getRawVal( 'useparsoid' );
		if (
			$queryEnable &&
			// Allow disabling via config change to manage parser cache usage
			\RequestContext::getMain()->getConfig()->get( 'ParsoidEnableQueryString' )
		) {
			$popts->setUseParsoid();
		}
		return true;
	}
}
