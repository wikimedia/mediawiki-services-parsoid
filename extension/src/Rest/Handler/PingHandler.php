<?php

namespace MWParsoid\Rest\Handler;

use MediaWiki\Rest\Handler;
use MediaWiki\Rest\StringStream;

/**
 * Test endpoint to make sure extension registration works.
 */
class PingHandler extends Handler {

	/** @inheritDoc */
	public function execute() {
		$response = $this->getResponseFactory()->create();
		$response->setStatus( 200 );
		$response->setHeader( 'Content-Type', 'text/plain' );
		$response->setBody( new StringStream( 'pong' ) );
		return $response;
	}

}
