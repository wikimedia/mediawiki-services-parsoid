<?php
declare( strict_types = 1 );

namespace MWParsoid\Rest\Handler;

use MediaWiki\Rest\Response;
use MediaWiki\Revision\RevisionAccessException;
use MediaWiki\Revision\SlotRecord;
use MWParsoid\Rest\FormatHelper;
use Wikimedia\Parsoid\Config\PageConfig;

/**
 * Handler for displaying or rendering the content of a page:
 * - /{domain}/v3/page/{format}/{title}
 * - /{domain}/v3/page/{format}/{title}/{revision}
 * @see https://www.mediawiki.org/wiki/Parsoid/API#GET
 */
class PageHandler extends ParsoidHandler {

	/** @inheritDoc */
	public function execute(): Response {
		$request = $this->getRequest();
		$format = $request->getPathParam( 'format' );

		if ( !in_array( $format, FormatHelper::VALID_PAGE ) ) {
			return $this->getResponseFactory()->createHttpError( 404, [
				'message' => "Invalid page format: ${format}",
			] );
		}

		$attribs = $this->getRequestAttributes();

		if ( !$this->acceptable( $attribs ) ) {
			return $this->getResponseFactory()->createHttpError( 406, [
				'message' => 'Not acceptable',
			] );
		}

		$oldid = (int)$attribs['oldid'];

		try {
			$pageConfig = $this->createPageConfig(
				$attribs['pageName'], $oldid
			);
		} catch ( RevisionAccessException $exception ) {
			return $this->getResponseFactory()->createHttpError( 404, [
				'message' => 'The specified revision is deleted or suppressed.',
			] );
		}

		// T234549
		if ( $pageConfig->getRevisionContent() === null ) {
			return $this->getResponseFactory()->createHttpError( 404, [
				'message' => 'The specified revision does not exist.',
			] );
		}

		if ( $format === FormatHelper::FORMAT_WIKITEXT ) {
			if ( !$oldid ) {
				return $this->createRedirectToOldidResponse(
					$pageConfig, $attribs
				);
			}
			return $this->getPageContentResponse( $pageConfig, $attribs );
		} else {
			return $this->wt2html( $pageConfig, $attribs );
		}
	}

	/**
	 * Return the content of a page. This is the case when GET /page/ is
	 * called with format=wikitext.
	 *
	 * @param PageConfig $pageConfig
	 * @param array $attribs Request attributes from getRequestAttributes()
	 * @return Response
	 */
	protected function getPageContentResponse(
		PageConfig $pageConfig, array $attribs
	) {
		$content = $pageConfig->getRevisionContent();
		if ( !$content ) {
			return $this->getResponseFactory()->createHttpError( 404, [
				'message' => 'The specified revision does not exist.',
			] );
		}
		$response = $this->getResponseFactory()->create();
		$response->setStatus( 200 );
		$response->setHeader( 'X-ContentModel', $content->getModel( SlotRecord::MAIN ) );
		FormatHelper::setContentType(
			$response, FormatHelper::FORMAT_WIKITEXT,
			$attribs['envOptions']['outputContentVersion']
		);
		$response->getBody()->write( $content->getContent( SlotRecord::MAIN ) );
		return $response;
	}

}
