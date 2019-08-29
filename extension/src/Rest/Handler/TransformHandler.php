<?php
declare( strict_types = 1 );

namespace MWParsoid\Rest\Handler;

use MediaWiki\Rest\Response;
use MWParsoid\Rest\FormatHelper;

/**
 * Handler for transforming content given in the request.
 * - /{domain}/v3/transform/{from}/to/{format}
 * - /{domain}/v3/transform/{from}/to/{format}/{title}
 * - /{domain}/v3/transform/{from}/to/{format}/{title}/{revision}
 * @see https://www.mediawiki.org/wiki/Parsoid/API#POST
 */
class TransformHandler extends ParsoidHandler {

	/**
	 * Transform content given in the request from or to wikitext.
	 * @return Response
	 */
	public function execute() {
		$request = $this->getRequest();
		$from = $request->getPathParam( 'from' );
		$format = $request->getPathParam( 'format' );

		$attribs = &$this->getRequestAttributes();
		$env = $this->createEnv( $attribs['pageName'], (int)$attribs['oldid'] );

		if ( $from === FormatHelper::FORMAT_WIKITEXT ) {
			// Accept wikitext as a string or object{body,headers}
			$wikitext = $attribs['opts']['wikitext'] ?? null;
			if ( is_array( $wikitext ) ) {
				$wikitext = $wikitext['body'];
				// We've been given a pagelanguage for this page.
				if ( isset( $attribs['opts']['wikitext']['headers']['content-language'] ) ) {
					$attribs['pagelanguage'] = $attribs['opts']['wikitext']['headers']['content-language'];
				}
			}
			// We've been given source for this page
			if ( $wikitext === null && isset( $attribs['opts']['original']['wikitext'] ) ) {
				$wikitext = $attribs['opts']['original']['wikitext']['body'];
				// We've been given a pagelanguage for this page.
				if ( isset( $attribs['opts']['original']['wikitext']['headers']['content-language'] ) ) {
					$attribs['pagelanguage']
						= $attribs['opts']['original']['wikitext']['headers']['content-language'];
				}
			}
			// Abort if no wikitext or title.
			// FIXME use proper validation
			if ( $wikitext === null && $attribs['titleMissing'] ) {
				throw new \LogicException( 'No title or wikitext was provided.' );
			}
			return $this->wt2html( $env, $attribs, $wikitext );
		} elseif ( $format === FormatHelper::FORMAT_WIKITEXT ) {
			// FIXME validate $html is present
			// Accept html as a string or object{body,headers}
			$html = $attribs['opts']['html'] ?? '';
			if ( is_array( $html ) ) {
				$html = $html['body'];
			}
			return $this->html2wt( $env, $attribs, $html );
		} else {
			return $this->pb2pb( $env, $attribs );
		}
	}

}
