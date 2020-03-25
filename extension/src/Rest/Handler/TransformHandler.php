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

		if (
			!isset( FormatHelper::VALID_TRANSFORM[$from] ) ||
			!in_array( $format, FormatHelper::VALID_TRANSFORM[$from] )
		) {
			return $this->getResponseFactory()->createHttpError( 404, [
				'message' => "Invalid transform: ${from}/to/${format}",
			] );
		}

		$attribs = &$this->getRequestAttributes();

		if ( !$this->acceptable( $attribs ) ) {
			return $this->getResponseFactory()->createHttpError( 406, [
				'message' => 'Not acceptable',
			] );
		}

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
			if ( $wikitext === null && $attribs['titleMissing'] ) {
				return $this->getResponseFactory()->createHttpError( 400, [
					'message' => 'No title or wikitext was provided.',
				] );
			}
			$pageConfig = $this->createPageConfig(
				$attribs['pageName'], (int)$attribs['oldid'], $wikitext,
				$attribs['pagelanguage']
			);
			return $this->wt2html( $pageConfig, $attribs, $wikitext );
		} elseif ( $format === FormatHelper::FORMAT_WIKITEXT ) {
			$html = $attribs['opts']['html'] ?? null;
			if ( $html === null ) {
				return $this->getResponseFactory()->createHttpError( 400, [
					'message' => 'No html was supplied.',
				] );
			}
			// Accept html as a string or object{body,headers}
			if ( is_array( $html ) ) {
				$html = $html['body'];
			}
			$wikitext = $attribs['opts']['original']['wikitext']['body'] ?? null;
			$pageConfig = $this->createPageConfig(
				$attribs['pageName'], (int)$attribs['oldid'], $wikitext
			);
			$hasOldId = (bool)$attribs['oldid'];
			if ( $hasOldId && $pageConfig->getRevisionContent() === null ) {
				return $this->getResponseFactory()->createHttpError( 404, [
					'message' => 'The specified revision does not exist.',
				] );
			}
			return $this->html2wt( $pageConfig, $attribs, $html );
		} else {
			$pageConfig = $this->createPageConfig(
				$attribs['pageName'], (int)$attribs['oldid'], null,
				$attribs['pagelanguage']
			);
			return $this->pb2pb( $pageConfig, $attribs );
		}
	}

}
