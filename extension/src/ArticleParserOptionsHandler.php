<?php

namespace MWParsoid;

use Article;
use MediaWiki\Page\Hook\ArticleParserOptionsHook;
use ParserOptions;
use WebRequest;

class ArticleParserOptionsHandler implements ArticleParserOptionsHook {

	/**
	 * Check if 'useparsoid=1' is passed in as a query param, and if so,
	 * set the useParsoid option in ParserOptions.
	 *
	 * @param WebRequest $request
	 * @param ParserOptions $popts
	 */
	public static function processUseParsoidQueryParam(
		WebRequest $request, ParserOptions $popts
	): void {
		$queryEnable = $request->getRawVal( 'useparsoid' );
		if (
			$queryEnable &&
			// Allow disabling via config change to manage parser cache usage
			\RequestContext::getMain()->getConfig()->get( 'ParsoidEnableQueryString' )
		) {
			$popts->setUseParsoid();
		}
	}

	/**
	 * @see https://www.mediawiki.org/wiki/Manual:Hooks/ArticleParserOptions
	 * @param Article $article
	 * @param ParserOptions $popts
	 * @return bool|void
	 */
	public function onArticleParserOptions( Article $article, ParserOptions $popts ) {
		// T335157: Enable Parsoid Read Views for articles as an experimental
		// feature; this is primarily used for internal testing at this time.
		self::processUseParsoidQueryParam( $article->getContext()->getRequest(), $popts );
		return true;
	}
}
