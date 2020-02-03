<?php
declare( strict_types = 1 );

namespace MWParsoid\Rest\Handler;

use MediaWiki\Rest\Response;
use MediaWiki\Revision\RevisionAccessException;
use MediaWiki\Revision\SlotRecord;
use MWParsoid\Rest\FormatHelper;
use Wikimedia\Parsoid\Config\Env;

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

		$oldid = (int)$attribs['oldid'];
		try {
			$env = $this->createEnv( $attribs['pageName'], $oldid, true /* titleShouldExist */ );
		} catch ( RevisionAccessException $exception ) {
			return $this->getResponseFactory()->createHttpError( 404, [
				'message' => 'The specified revision is deleted or suppressed.',
			] );
		}
		if ( !$env ) {
			return $this->getResponseFactory()->createHttpError( 404, [
				'message' => 'The specified revision does not exist.',
			] );
		}

		if ( !$this->acceptable( $attribs ) ) {
			return $this->getResponseFactory()->createHttpError( 406, [
				'message' => 'Not acceptable',
			] );
		}

		if ( $format === FormatHelper::FORMAT_WIKITEXT ) {
			if ( !$oldid ) {
				return $this->createRedirectToOldidResponse( $env, $attribs );
			}
			return $this->getPageContentResponse( $env, $attribs );
		} else {
			return $this->wt2html( $env, $attribs );
		}
	}

	/**
	 * Return the content of a page. This is the case when GET /page/ is called with format=wikitext.
	 * @param Env $env
	 * @param array $attribs Request attributes from getRequestAttributes()
	 * @return Response
	 */
	protected function getPageContentResponse( Env $env, array $attribs ) {
		$content = $env->getPageConfig()->getRevisionContent();
		if ( !$content ) {
			return $this->getResponseFactory()->createHttpError( 404, [
				'message' => 'The specified revision does not exist.',
			] );
		}

		$response = $this->getResponseFactory()->create();
		$response->setStatus( 200 );
		$response->setHeader( 'X-ContentModel', $content->getModel( SlotRecord::MAIN ) );
		FormatHelper::setContentType( $response, FormatHelper::FORMAT_WIKITEXT,
			$attribs['envOptions']['outputContentVersion'] );
		$response->getBody()->write( $content->getContent( SlotRecord::MAIN ) );
		return $response;
	}

}
