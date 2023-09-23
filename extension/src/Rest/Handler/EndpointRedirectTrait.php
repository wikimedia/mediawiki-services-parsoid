<?php
/**
 * Copyright (C) 2011-2020 Wikimedia Foundation and others.
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program; if not, write to the Free Software Foundation, Inc.,
 * 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA.
 */
declare( strict_types = 1 );

namespace MWParsoid\Rest\Handler;

use LogicException;
use MediaWiki\MediaWikiServices;
use MediaWiki\Rest\Handler;
use MediaWiki\Rest\Handler\Helper\ParsoidFormatHelper;
use MediaWiki\Rest\RequestInterface;
use MediaWiki\Rest\Response;
use MediaWiki\Rest\ResponseFactory;

/**
 * Trait for overriding methods in ParsoidHandler that control the redirect targets.
 * This is used by endpoints in the parsoid extensions to change the redirect targets
 * from endpoints defined in MediaWiki core to the endpoints defined by the parsoid
 * extension.
 */
trait EndpointRedirectTrait {

	/**
	 * Override the transform endpoint path.
	 * @see ParsoidHandler::getTransformEndpoint
	 *
	 * @param string $format The format the endpoint is expected to return.
	 *
	 * @return string
	 */
	protected function getTransformEndpoint( string $format = ParsoidFormatHelper::FORMAT_HTML ): string {
		return '/{domain}/v3/transform/{from}/to/{format}/{title}/{revision}';
	}

	/**
	 * Override the page content endpoint path.
	 * @see ParsoidHandler::getPageContentEndpoint
	 *
	 * @param string $format The format the endpoint is expected to return.
	 *
	 * @return string
	 */
	protected function getPageContentEndpoint( string $format = ParsoidFormatHelper::FORMAT_HTML ): string {
		return '/{domain}/v3/page/{format}/{title}';
	}

	/**
	 * Override the revision content endpoint path.
	 * @see ParsoidHandler::getRevisionContentEndpoint
	 *
	 * @param string $format The format the endpoint is expected to return.
	 *
	 * @return string
	 */
	protected function getRevisionContentEndpoint( string $format = ParsoidFormatHelper::FORMAT_HTML ): string {
		return '/{domain}/v3/page/{format}/{title}/{revision}';
	}

	/**
	 * Overrides createRedirectResponse in order to implement redirects relative
	 * to the server and protocol that were used to make the current request.
	 *
	 * @see ParsoidHandler::createRedirectResponse
	 *
	 * @param string $path Target URL
	 * @param array $pathParams Path parameters to inject into path
	 * @param array $queryParams Query parameters
	 *
	 * @return Response
	 */
	protected function createRedirectResponse(
		string $path, array $pathParams = [], array $queryParams = []
	): Response {
		// FIXME: We should not override ParsoidHandler::createRedirectResponse().
		//        Instead, we should implement the relevant logic in getRedirectRouteUrl().
		//        For now, this is needed to ensure that redirects will use the internal
		//        server and protocol ($wgInternalServer) if the endpoint was invoked
		//        as a private endpoint. See T311867.
		global $wgRestPath;
		$urlUtils = MediaWikiServices::getInstance()->getUrlUtils();
		$path = $urlUtils->expand( "$wgRestPath$path", PROTO_CURRENT );
		foreach ( $pathParams as $param => $value ) {
			// NOTE: we use rawurlencode here, since execute() uses rawurldecode().
			// Spaces in path params must be encoded to %20 (not +).
			$path = str_replace( '{' . $param . '}', rawurlencode( (string)$value ), $path );
		}
		// XXX: this should not be necessary in the REST entry point
		unset( $queryParams['title'] );
		if ( $queryParams ) {
			$path .= ( strpos( $path, '?' ) === false ? '?' : '&' )
				. http_build_query( $queryParams, '', '&', PHP_QUERY_RFC3986 );
		}
		if ( $this->getRequest()->getMethod() === 'POST' ) {
			$response = $this->getResponseFactory()->createTemporaryRedirect( $path );
		} else {
			$response = $this->getResponseFactory()->createLegacyTemporaryRedirect( $path );
		}
		$response->setHeader( 'Cache-Control', 'private,no-cache,s-maxage=0' );
		return $response;
	}

	/**
	 * @see Handler::getResponseFactory
	 * @return ResponseFactory
	 */
	abstract protected function getResponseFactory();

	/**
	 * @see Handler::getRequest
	 * @return RequestInterface
	 */
	abstract protected function getRequest();

	/**
	 * @see ParsoidHandler::getRedirectRouteUrl
	 *
	 * @param string $path
	 * @param array $pathParams
	 * @param array $queryParams
	 *
	 * @return never
	 */
	protected function getRedirectRouteUrl(
		string $path, array $pathParams = [], array $queryParams = []
	) {
		// TODO: this should call $this->getRouter()->getRouteUrl() or
		// $this->getRouter()->getPrivateRouteUrl(), depending on a configuration
		// setting, or on some logic that detects whether the current request is
		// to a private endpoint.
		// Once we have this logic here, we no longer need to override
		// createRedirectResponse().
		// Background: On the WMF cluster, the parsoid extension endpoints are not public,
		// and redirects should be based on $wgInternalServer. But third party wikis may
		// want to have these endpoints public. See T311867.
		throw new LogicException( 'Not Implemented' );
	}

}
